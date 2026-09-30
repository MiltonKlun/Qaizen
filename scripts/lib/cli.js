// @ts-check
// Shared command-line handling (task group 10.1): the `.env` subset the repo
// documents, and strict argument parsing.
//
// Before this, each adapter parsed its own arguments with `argv.includes` and
// "the first argument that does not start with --": an unknown option was
// silently ignored, `--out` without a value fell back to a default, and
// `--out report.md STORY-1` took `report.md` as the story. Two scripts also
// carried their own copy of the `.env` loader. Everything here is shared, and
// every rule is tested (test/cli.test.js).
//
// Parsing is Node's own `util.parseArgs` in strict mode (unknown options and
// missing values are errors), plus what it does not check: a flag given
// twice, incompatible flags, integer ranges, and story ids.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { validateComponent } from './execution-paths.js';

// ------------------------------------------------------------------ .env

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse `.env` text: the subset `.env.example` documents, nothing more.
 *
 *   - blank lines and lines starting with `#` are ignored;
 *   - `KEY=value`, with whitespace around `=` and the value trimmed;
 *   - a value in matching double or single quotes is taken verbatim, with
 *     no escape processing and no `${}` expansion;
 *   - an unquoted value ends at a comment that starts with whitespace + `#`
 *     (a `#` inside a value, such as a URL fragment, is kept);
 *   - CRLF line endings are accepted.
 *
 * A line that fits none of these is not guessed at: it is reported by line
 * number and skipped.
 *
 * @param {string} text
 * @returns {{ values: Record<string, string>, invalidLines: number[] }}
 */
export function parseDotEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {number[]} */
  const invalidLines = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    const key = eq === -1 ? '' : line.slice(0, eq).trim();
    if (!KEY.test(key)) {
      invalidLines.push(i + 1);
      return;
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      const rest = end === -1 ? '' : value.slice(end + 1).trim();
      if (end === -1 || (rest && !rest.startsWith('#'))) {
        invalidLines.push(i + 1);
        return;
      }
      value = value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    values[key] = value;
  });
  return { values, invalidLines };
}

/**
 * Fill environment gaps from a local `.env` file. A variable already set in
 * the environment — even to an empty string — always wins.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [path]
 * @returns {{ loaded: string[], invalidLines: number[] }}
 */
export function loadDotEnv(env = process.env, path = '.env') {
  if (!existsSync(path)) return { loaded: [], invalidLines: [] };
  const { values, invalidLines } = parseDotEnv(readFileSync(path, 'utf8'));
  /** @type {string[]} */
  const loaded = [];
  for (const [k, v] of Object.entries(values)) {
    if (k in env) continue;
    env[k] = v;
    loaded.push(k);
  }
  if (invalidLines.length) {
    console.warn(
      `${path}: ignored line(s) ${invalidLines.join(', ')} (expected KEY=value)`
    );
  }
  return { loaded, invalidLines };
}

// ------------------------------------------------------------------ args

/**
 * @typedef {{ type: 'boolean' } | { type: 'string', choices?: string[] }
 *   | { type: 'string', multiple: true } | { type: 'integer', min: number }}
 *   OptionSpec
 */
/**
 * @typedef {object} CliSpec
 * @property {string} usage              the usage line printed on an error
 * @property {Record<string, OptionSpec>} options
 * @property {{ name: string, validate?: (v: string) => string | null }[]} [positionals]
 *   required positionals, in order; `validate` returns an error or null
 * @property {string[][]} [exclusive]    groups of options that cannot be combined
 */
/**
 * @typedef {{ ok: true, positionals: Record<string, string>,
 *   values: Record<string, boolean | string | string[] | number | undefined> }
 *   | { ok: false, error: string }} CliResult
 */

/**
 * Parse arguments strictly. Options may come before or after the positionals;
 * each script's usage line says so.
 *
 * @param {string[]} args  process.argv.slice(2)
 * @param {CliSpec} spec
 * @returns {CliResult}
 */
export function parseCli(args, spec) {
  /** @type {Record<string, { type: 'boolean' | 'string', multiple?: boolean }>} */
  const options = {};
  for (const [name, o] of Object.entries(spec.options)) {
    options[name] = {
      type: o.type === 'boolean' ? 'boolean' : 'string',
      ...('multiple' in o && o.multiple ? { multiple: true } : {}),
    };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // A single-valued option given twice keeps only its last value in
  // util.parseArgs; here it is an error, because which one was meant is unknown.
  /** @type {Record<string, number>} */
  const seen = {};
  for (const t of parsed.tokens ?? []) {
    if (t.kind !== 'option') continue;
    seen[t.name] = (seen[t.name] ?? 0) + 1;
    const o = spec.options[t.name];
    if (seen[t.name] > 1 && !('multiple' in o && o.multiple)) {
      return { ok: false, error: `--${t.name} was given more than once` };
    }
  }

  /** @type {Record<string, boolean | string | string[] | number | undefined>} */
  const values = {};
  for (const [name, o] of Object.entries(spec.options)) {
    const v = /** @type {string | boolean | string[] | undefined} */ (
      parsed.values[name]
    );
    if (v === undefined) {
      values[name] = undefined;
      continue;
    }
    if (o.type === 'integer') {
      const n = Number(v);
      if (!/^-?\d+$/.test(String(v)) || !Number.isSafeInteger(n) || n < o.min) {
        return {
          ok: false,
          error: `--${name} expects an integer of at least ${o.min} (got "${v}")`,
        };
      }
      values[name] = n;
    } else if (o.type === 'string' && 'choices' in o && o.choices) {
      if (!o.choices.includes(String(v))) {
        return {
          ok: false,
          error: `--${name} must be one of ${o.choices.join(', ')} (got "${v}")`,
        };
      }
      values[name] = v;
    } else {
      values[name] = v;
    }
  }

  for (const group of spec.exclusive ?? []) {
    const given = group.filter((name) => values[name] !== undefined);
    if (given.length > 1) {
      return {
        ok: false,
        error: `${given.map((n) => `--${n}`).join(' and ')} cannot be combined`,
      };
    }
  }

  const wanted = spec.positionals ?? [];
  if (parsed.positionals.length !== wanted.length) {
    return {
      ok: false,
      error:
        parsed.positionals.length < wanted.length
          ? `missing ${wanted
              .slice(parsed.positionals.length)
              .map((p) => `<${p.name}>`)
              .join(' ')}`
          : `unexpected argument(s): ${parsed.positionals
              .slice(wanted.length)
              .join(' ')}`,
    };
  }
  /** @type {Record<string, string>} */
  const positionals = {};
  for (const [i, p] of wanted.entries()) {
    const v = parsed.positionals[i];
    const problem = p.validate ? p.validate(v) : null;
    if (problem) return { ok: false, error: problem };
    positionals[p.name] = v;
  }
  return { ok: true, positionals, values };
}

/**
 * A story id is also a path component (runs/<story>/, test-cases/<story>.json),
 * so it must be one: letters, digits, dot, dash, underscore.
 * @param {string} value
 * @returns {string | null}
 */
export function validateStoryId(value) {
  const r = validateComponent(value, 'story id');
  return r.ok ? null : (r.message ?? 'story id is invalid');
}

/**
 * Parse, or print the error and the usage line and exit 2.
 * @param {string[]} args
 * @param {CliSpec} spec
 */
export function parseCliOrExit(args, spec) {
  const r = parseCli(args, spec);
  if (!r.ok) {
    console.error(`Error: ${r.error}`);
    console.error(spec.usage);
    process.exit(2);
  }
  return r;
}

// ------------------------------------------------------------ Node tools

/**
 * The Playwright CLI entry point, run as `process.execPath <cli> ...` so no
 * shell or `npx` lookup is involved and every argument reaches Playwright
 * literally. QAIZEN_PLAYWRIGHT_CLI overrides it (tests use a stand-in).
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function playwrightCli(env = process.env) {
  if (env.QAIZEN_PLAYWRIGHT_CLI) return resolve(env.QAIZEN_PLAYWRIGHT_CLI);
  return createRequire(import.meta.url).resolve('@playwright/test/cli');
}

// ------------------------------------------------------------ value parsers

/**
 * Parse --resolve values of the form LOCAL-ID=REMOTE-ID or LOCAL-ID=none.
 * @param {string[]} specs
 * @returns {{ localId: string, remote: string | null }[]}
 */
export function parseResolutions(specs) {
  return specs.map((spec) => {
    const m = spec.match(/^([A-Za-z]+-[0-9]+)=(.+)$/);
    if (!m) {
      throw new Error(
        `--resolve expects LOCAL-ID=REMOTE-ID or LOCAL-ID=none (got "${spec}")`
      );
    }
    return { localId: m[1], remote: m[2] === 'none' ? null : m[2] };
  });
}
