// Shared artifact I/O: one AJV configuration, validated atomic writes, and a
// run-scoped loader (IMPLEMENTATION_PLAN task group 2.1, review finding I6).
//
// WHY: three scripts each built their own `new Ajv({allErrors:true,
// strict:false})` and two separately reimplemented a compiled-schema cache
// (validate-json.js, validate-examples.js, validate-all.js). CLAUDE.md section
// 3.3 says there is exactly ONE generic validator; that was true of the CLI but
// not of the AJV configuration behind it, which could drift. This module is the
// single implementation all of them now consume.
//
// It also closes the write half of I6: the runner validated context AFTER
// overwriting the file, so a schema-invalid write destroyed the previous valid
// artifact. `writeJsonAtomic` validates in memory FIRST, writes a sibling temp
// file, then renames — so a rejected value never touches the destination.
//
// Scope note: this module owns validation and safe writing. It deliberately
// does NOT own discovery (which files exist) — the wrappers keep that, because
// their discovery rules and their missing-schema POLICIES legitimately differ:
// validate-examples treats an absent schema as skip-with-warning, validate-all
// treats it as a hard error. So `compileSchema` reports absence; it does not
// decide what absence means.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  realpathSync,
  mkdirSync,
} from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Failure kinds, kept distinct so callers can react differently and so
 * diagnostics never say "invalid" when the real problem was a missing file.
 */
export const IO_ERROR = {
  MISSING_FILE: 'missing_file',
  UNREADABLE: 'unreadable',
  MALFORMED_JSON: 'malformed_json',
  MISSING_SCHEMA: 'missing_schema',
  INVALID_SCHEMA: 'invalid_schema',
  SCHEMA_INVALID_DATA: 'schema_invalid_data',
  IDENTITY_MISMATCH: 'identity_mismatch',
  PATH_ESCAPE: 'path_escape',
  WRITE_FAILED: 'write_failed',
};

/** The ONE AJV instance configuration for the whole pipeline. */
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Cache compiled schemas by RESOLVED path, so two callers spelling the same
// schema differently ("schemas/x.json" vs an absolute path) share one compile.
const compiledByPath = new Map();

/**
 * Compile a schema, caching by resolved path.
 * @returns {{ok: true, validate: Function} | {ok: false, kind: string, message: string}}
 */
export function compileSchema(schemaPath) {
  const key = resolve(schemaPath);
  if (compiledByPath.has(key)) return compiledByPath.get(key);

  if (!existsSync(key)) {
    // Absence is REPORTED, not interpreted — the caller decides whether a
    // missing schema is a skip or a fatal error.
    return {
      ok: false,
      kind: IO_ERROR.MISSING_SCHEMA,
      message: `Schema not found: ${schemaPath}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(key, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.INVALID_SCHEMA,
      message: `Schema ${schemaPath} is not valid JSON: ${err.message}`,
    };
  }

  let validate;
  try {
    validate = ajv.compile(parsed);
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.INVALID_SCHEMA,
      message: `Schema ${schemaPath} failed to compile: ${err.message}`,
    };
  }

  const result = { ok: true, validate };
  compiledByPath.set(key, result);
  return result;
}

/**
 * Read + parse a JSON file, distinguishing missing from unreadable from
 * malformed.
 * @returns {{ok: true, data: unknown} | {ok: false, kind: string, message: string}}
 */
export function readJson(path) {
  const full = resolve(path);
  if (!existsSync(full)) {
    return {
      ok: false,
      kind: IO_ERROR.MISSING_FILE,
      message: `File not found: ${path}`,
    };
  }
  let raw;
  try {
    raw = readFileSync(full, 'utf8');
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.UNREADABLE,
      message: `Could not read ${path}: ${err.message}`,
    };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.MALFORMED_JSON,
      message: `${path} is not valid JSON: ${err.message}`,
    };
  }
}

/**
 * Format AJV errors as field-path lines.
 *
 * Deliberately prints the instance path, the message and AJV's params — never
 * the offending VALUE. An artifact can carry sensitive data, and a validation
 * diagnostic is exactly the kind of text that ends up in CI logs and issues.
 */
export function formatErrors(errors, { includeParams = true } = {}) {
  return (errors ?? []).map((err) => {
    const where = err.instancePath || '(root)';
    const params =
      includeParams && Object.keys(err.params ?? {}).length
        ? ' ' + JSON.stringify(err.params)
        : '';
    return `  ${where}: ${err.message}${params}`;
  });
}

/**
 * Validate an in-memory value against a schema.
 * @returns {{ok: true} | {ok: false, kind: string, message: string, errors?: object[]}}
 */
export function validateValue(value, schemaPath) {
  const compiled = compileSchema(schemaPath);
  if (!compiled.ok) return compiled;
  if (compiled.validate(value)) return { ok: true };
  return {
    ok: false,
    kind: IO_ERROR.SCHEMA_INVALID_DATA,
    message: `Value does NOT validate against ${schemaPath}`,
    errors: compiled.validate.errors ?? [],
  };
}

/**
 * Read a file and validate it in one step.
 */
export function readValidatedJson(path, schemaPath) {
  const read = readJson(path);
  if (!read.ok) return read;
  const valid = validateValue(read.data, schemaPath);
  if (!valid.ok) {
    return {
      ...valid,
      message: `${path} does NOT validate against ${schemaPath}`,
    };
  }
  return { ok: true, data: read.data };
}

/**
 * Reject a destination that escapes its allowed root.
 *
 * Checks the RESOLVED path, and where the parent directory already exists also
 * its realpath — so a symlink or Windows junction pointing outside the root is
 * caught rather than followed on write.
 */
export function assertWithinRoot(targetPath, root) {
  const rootResolved = resolve(root);
  const target = resolve(targetPath);

  const withinLexical =
    target === rootResolved || target.startsWith(rootResolved + sep);
  if (!withinLexical) {
    return {
      ok: false,
      kind: IO_ERROR.PATH_ESCAPE,
      message: `Refusing to write outside the allowed root: ${targetPath}`,
    };
  }

  // The root itself is trivially within the root; comparing its PARENT against
  // the root would always "escape". Only descendants need the link check.
  if (target === rootResolved) return { ok: true };

  // Resolve symlinks/junctions on the nearest existing ancestor.
  let probe = dirname(target);
  while (probe && !existsSync(probe) && probe !== dirname(probe)) {
    probe = dirname(probe);
  }
  if (probe && existsSync(probe)) {
    let realParent;
    try {
      realParent = realpathSync(probe);
    } catch {
      realParent = probe;
    }
    let realRoot;
    try {
      realRoot = realpathSync(rootResolved);
    } catch {
      realRoot = rootResolved;
    }
    const withinReal =
      realParent === realRoot || realParent.startsWith(realRoot + sep);
    if (!withinReal) {
      return {
        ok: false,
        kind: IO_ERROR.PATH_ESCAPE,
        message: `Refusing to write through a link that escapes the allowed root: ${targetPath}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validate, then write atomically.
 *
 * Order matters and is the point of this function: validate IN MEMORY, write a
 * sibling temp file, then rename over the destination. If validation fails, or
 * the write fails, the existing destination bytes are untouched and the caller
 * gets a non-ok result — never a partial or invalid artifact.
 *
 * @param {string} path destination
 * @param {unknown} value the value to serialize
 * @param {object} [opts]
 * @param {string} [opts.schemaPath] validate against this schema first
 * @param {string} [opts.root] reject destinations escaping this root
 */
export function writeJsonAtomic(path, value, opts = {}) {
  const { schemaPath, root } = opts;

  if (root) {
    const within = assertWithinRoot(path, root);
    if (!within.ok) return within;
  }

  if (schemaPath) {
    const valid = validateValue(value, schemaPath);
    if (!valid.ok) {
      // Only an actual validation failure may say "does NOT validate". A
      // missing or broken SCHEMA is a different problem, and reporting it as a
      // bad value sends the reader hunting for a field that is fine.
      const why =
        valid.kind === IO_ERROR.SCHEMA_INVALID_DATA
          ? `it does NOT validate against ${schemaPath}`
          : `its schema could not be loaded (${valid.message})`;
      return { ...valid, message: `Refusing to write ${path}: ${why}` };
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2) + '\n';
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.WRITE_FAILED,
      message: `Refusing to write ${path}: value is not serializable (${err.message})`,
    };
  }

  const target = resolve(path);
  const dir = dirname(target);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      kind: IO_ERROR.WRITE_FAILED,
      message: `Could not create directory for ${path}: ${err.message}`,
    };
  }

  // Temp file is OURS: unique name, same directory (so rename stays atomic on
  // one filesystem). Only this path is ever cleaned up.
  const tmp = join(
    dir,
    `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    writeFileSync(tmp, serialized);
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort: never mask the original write error with a cleanup error.
    }
    return {
      ok: false,
      kind: IO_ERROR.WRITE_FAILED,
      message: `Could not write ${path}: ${err.message}`,
    };
  }
}

/**
 * Extract the story/run identity an artifact claims, across the shapes the
 * pipeline uses (`context.json` nests it under `story`; other artifacts carry
 * `story_id` at the top level).
 */
export function artifactIdentity(data) {
  const story =
    (data && data.story && data.story.id) || (data && data.story_id) || null;
  const run = (data && data.run_id) || null;
  return { storyId: story, runId: run };
}

/**
 * Load an artifact and confirm it belongs to the run the caller is working on.
 *
 * I6 in one sentence: "existing file" is not the same as "valid artifact for
 * THIS run". A stale artifact from a previous story satisfied progress checks
 * because only its existence was tested.
 *
 * @param {string} path
 * @param {string} schemaPath
 * @param {object} [expect] `{storyId, runId}` — each checked only when given
 */
export function loadRunArtifact(path, schemaPath, expect = {}) {
  const read = readValidatedJson(path, schemaPath);
  if (!read.ok) return read;

  const found = artifactIdentity(read.data);

  if (expect.storyId && found.storyId && found.storyId !== expect.storyId) {
    return {
      ok: false,
      kind: IO_ERROR.IDENTITY_MISMATCH,
      message: `${path} belongs to story ${found.storyId}, not ${expect.storyId}`,
    };
  }
  // A required identity that the artifact does not carry at all is also a
  // mismatch: we cannot confirm it belongs to this run.
  if (expect.storyId && !found.storyId) {
    return {
      ok: false,
      kind: IO_ERROR.IDENTITY_MISMATCH,
      message: `${path} carries no story identity; cannot confirm it belongs to ${expect.storyId}`,
    };
  }
  if (expect.runId && found.runId && found.runId !== expect.runId) {
    return {
      ok: false,
      kind: IO_ERROR.IDENTITY_MISMATCH,
      message: `${path} belongs to run ${found.runId}, not ${expect.runId}`,
    };
  }

  return { ok: true, data: read.data, identity: found };
}
