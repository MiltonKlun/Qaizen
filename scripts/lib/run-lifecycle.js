// Run lifecycle: ownership, verified archiving, and the recoverable
// new-story transition (task group 4.1, finding B3).
//
// The repo ROOT holds the current run; runs/<story>/<archive-id>/ is history.
// Starting a new story used to overwrite story.md and then load the OLD
// context.json, so a completed run immediately "finished" the new story and an
// incomplete one silently absorbed it. This module provides the pieces that
// make a transition safe:
//
//   - classifyRootArtifacts(): which root files belong to the current run, and
//     which cannot be attributed to it (those stop the transition);
//   - archiveRun(): copy exactly those files, verify every byte by SHA-256,
//     validate copied JSON, write a manifest -- never touching the root;
//   - clearArchived(): remove a root file only if it still matches the digest
//     that was archived;
//   - a small transition record (.qaizen/transition.json) for FILE MOVEMENT
//     ONLY, so an interrupted transition can be finished or undone
//     deterministically. It is never a source of pipeline decisions: gates and
//     steps still come from context.json.
//
// Nothing here formats files. The old archiver ran Prettier over the snapshot,
// which rewrote the archived bytes; an archive is evidence and stays
// byte-identical to what the run produced.

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IO_ERROR, validateValue, writeJsonAtomic } from './artifact-io.js';
import { validateComponent } from './execution-paths.js';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = (name) => join(REPO_DIR, 'schemas', name);

/** Transient runner state. Local only; never versioned. */
export const STATE_DIR = '.qaizen';
export const TRANSITION_FILE = join(STATE_DIR, 'transition.json');
const STAGING_DIR = join(STATE_DIR, 'staging');

/** Where a run's artifacts live at the root. */
export const RUN_DIRS = [
  'test-cases',
  'planner-input',
  'specs',
  'tests',
  'api-tests',
  'analysis',
  'release',
];

/** Run-scoped singletons: at most one run occupies the root at a time. */
const RUN_SCOPED = [
  /^analysis\/failure-analysis\.json$/,
  /^analysis\/execution-ledger\.json$/,
  /^analysis\/healer-validation\//,
  /^release\/release-report\.(md|json)$/,
  /^release\/bug-drafts\/BUG-\d+\.md$/,
  /^release\/healer-patches\//,
];

/** JSON artifacts whose copy is schema-validated in the archive. */
const JSON_SCHEMAS = [
  [/^context\.json$/, 'context.schema.json'],
  [/^test-cases\/[^/]+\.json$/, 'test-cases.schema.json'],
  [/^analysis\/failure-analysis\.json$/, 'failure-analysis.schema.json'],
  [/^analysis\/execution-ledger\.json$/, 'execution-ledger.schema.json'],
  [/^release\/release-report\.json$/, 'release-report.schema.json'],
];

const posix = (p) => p.split(sep).join('/');

/**
 * Best-effort cleanup that never throws. `rmSync({force: true})` only ignores
 * ENOENT: on Linux a path under a FILE raises ENOTDIR, which escaped the
 * archive-failure path as a raw crash and left the transition record behind
 * (caught by CI; Windows reports the same path as missing). A cleanup failure
 * must never mask the error that caused it.
 */
function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

/** Shared by every run: never archived, never removed. */
export function isReusable(rel) {
  const base = rel.split('/').pop();
  return (
    base === '.gitkeep' ||
    rel === 'tests/seed.spec.ts' ||
    rel.startsWith('tests/fixtures/')
  );
}

/** A file named for this story (`STORY-1.json`, `STORY-1-login.spec.ts`), but
 *  never a different story that shares the prefix (`STORY-10.json`). */
function isStoryScoped(rel, storyId) {
  if (!storyId) return false;
  const base = rel.split('/').pop();
  const escaped = storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?![0-9A-Za-z])`).test(base);
}

function walkFiles(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Attribute every root artifact to the current run, or refuse to.
 *
 * Owned: context.json, story.md, every existing artifact_paths target outside
 * reports/ (regenerable), files named for the story, and the run-scoped
 * singletons. Reusable files (seed test, fixtures, .gitkeep) are never owned.
 * Anything else inside the run directories is UNKNOWN: a transition that
 * cannot say whose it is must stop rather than archive or delete it.
 *
 * @returns {{owned: string[], unknown: string[], outside: string[]}}
 */
export function classifyRootArtifacts(context, root = '.') {
  const storyId = context?.story?.id ?? null;
  const owned = new Set();
  const outside = [];
  const rootAbs = resolve(root);

  for (const f of ['context.json', 'story.md']) {
    if (existsSync(join(root, f))) owned.add(f);
  }

  for (const value of Object.values(context?.artifact_paths ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    const abs = resolve(root, value);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      outside.push(value);
      continue;
    }
    const rel = posix(relative(rootAbs, abs));
    if (rel === 'reports' || rel.startsWith('reports/')) continue;
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? walkFiles(root, rel) : [rel];
    for (const f of files) if (!isReusable(f)) owned.add(f);
  }

  const unknown = [];
  for (const dir of RUN_DIRS) {
    for (const rel of walkFiles(root, dir)) {
      if (owned.has(rel) || isReusable(rel)) continue;
      if (
        isStoryScoped(rel, storyId) ||
        RUN_SCOPED.some((re) => re.test(rel))
      ) {
        owned.add(rel);
      } else {
        unknown.push(rel);
      }
    }
  }

  return { owned: [...owned].sort(), unknown: unknown.sort(), outside };
}

/** A sortable, unique id: `2026-09-22T23-30-00Z-<7 hex>`. */
export function newRunId(now = new Date(), seed = randomUUID()) {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `${stamp}-${sha256Buffer(Buffer.from(seed)).slice(0, 7)}`;
}

/**
 * Copy the run's owned files into runs/<story>/<archive-id>/ and prove it.
 *
 * Every copy is re-read and compared by SHA-256; copied JSON is parsed and,
 * for known artifact types, schema-validated (an invalid artifact is still
 * archived -- it is evidence -- but the manifest says so). On any failure the
 * partial archive is removed and the ROOT IS UNTOUCHED.
 *
 * @returns {{ok: true, archiveDir: string, manifest: object} |
 *           {ok: false, message: string}}
 */
export function archiveRun({
  root = '.',
  storyId,
  context,
  files,
  label = null,
  now = new Date(),
}) {
  const check = validateComponent(storyId, 'story id');
  if (!check.ok) return check;

  const archiveId = newRunId(now);
  const archiveRel = posix(join('runs', storyId, archiveId));
  const archiveAbs = join(root, archiveRel);
  if (existsSync(archiveAbs)) {
    return { ok: false, message: `archive ${archiveRel} already exists` };
  }

  const records = [];
  try {
    mkdirSync(archiveAbs, { recursive: true });
    for (const rel of files) {
      const src = join(root, rel);
      const dst = join(archiveAbs, rel);
      const before = sha256File(src);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      const after = sha256File(dst);
      if (after !== before) {
        throw new Error(`copy of ${rel} does not match its source digest`);
      }
      const rec = { path: rel, sha256: before, bytes: statSync(dst).size };
      if (rel.endsWith('.json')) {
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(dst, 'utf8'));
        } catch {
          rec.json = 'unparseable';
        }
        if (parsed !== undefined) {
          const match = JSON_SCHEMAS.find(([re]) => re.test(rel));
          if (match) {
            rec.schema = `schemas/${match[1]}`;
            const v = validateValue(parsed, schema(match[1]));
            // Only a real validation verdict is recorded as valid/invalid; an
            // unloadable schema must not brand good evidence as invalid.
            if (v.ok) rec.valid = true;
            else if (v.kind === IO_ERROR.SCHEMA_INVALID_DATA) rec.valid = false;
            else rec.schema_unavailable = true;
          }
        }
      }
      records.push(rec);
    }

    const manifest = {
      run_id: archiveId,
      story_id: storyId,
      label,
      archived_at: now.toISOString(),
      source_context_run_id: context?.run_id ?? null,
      status_at_archive: context?.status ?? null,
      // Kept for existing readers (list-runs, metrics).
      archived_files: records.map((r) => r.path),
      archived_dirs: [
        ...new Set(
          records
            .map((r) => r.path.split('/')[0])
            .filter((d) => RUN_DIRS.includes(d))
        ),
      ].sort(),
      // Byte-level proof of what was archived. Nothing here is reformatted.
      files: records,
    };
    writeFileSync(
      join(archiveAbs, 'run-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );

    // Update the per-project latest pointer last: the archive is complete.
    const latestPath = join(root, 'runs', 'latest.json');
    let latest = {};
    if (existsSync(latestPath)) {
      try {
        latest = JSON.parse(readFileSync(latestPath, 'utf8'));
      } catch {
        latest = {};
      }
    }
    latest[storyId] = {
      run_id: archiveId,
      label,
      archived_at: manifest.archived_at,
    };
    writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');

    return { ok: true, archiveDir: archiveRel, manifest };
  } catch (e) {
    removeQuietly(archiveAbs);
    return {
      ok: false,
      message: `archive failed, nothing at the root was changed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Remove archived root files -- only those still byte-identical to what was
 * archived. A file edited after archiving is left in place and reported.
 */
export function clearArchived(root, records) {
  const removed = [];
  const changed = [];
  for (const { path: rel, sha256 } of records) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (sha256File(abs) !== sha256) {
      changed.push(rel);
      continue;
    }
    unlinkSync(abs);
    removed.push(rel);
  }
  return { removed, changed };
}

// ---- the transition record ------------------------------------------------

export function readTransition(root = '.') {
  const p = join(root, TRANSITION_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { phase: 'corrupt' };
  }
}

export function writeTransition(root, record) {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  const r = writeJsonAtomic(join(root, TRANSITION_FILE), record);
  if (!r.ok) throw new Error(r.message);
}

export function removeTransition(root = '.') {
  removeQuietly(join(root, TRANSITION_FILE));
  removeQuietly(join(root, STAGING_DIR));
}

/** A task-owned staging directory for one transition. */
export function stagingDir(root, txid) {
  const dir = join(root, STAGING_DIR, txid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Finish or undo an interrupted transition. Deterministic:
 *
 *   staging  -> ROLL BACK. The root was never touched; discard the staged
 *               story and any partial archive. The old run stays current.
 *   archived -> ROLL FORWARD. The archive is complete and verified, so the
 *   cleared     old run is safe; finish clearing and install the new story.
 *   installed -> nothing to recover; a staged run is waiting for the Analyst.
 *
 * @returns {{action: 'none'|'rolled_back'|'rolled_forward', message: string,
 *            ok: boolean}}
 */
export function recoverTransition(root = '.') {
  const rec = readTransition(root);
  if (!rec) return { ok: true, action: 'none', message: '' };
  if (rec.phase === 'installed')
    return { ok: true, action: 'none', message: '' };

  if (rec.phase === 'staging') {
    if (rec.archive_dir) {
      removeQuietly(join(root, rec.archive_dir));
    }
    removeTransition(root);
    return {
      ok: true,
      action: 'rolled_back',
      message:
        'Rolled back an interrupted new-story transition: nothing at the root had been changed; ' +
        'the previous run is still current.',
    };
  }

  if (rec.phase === 'archived' || rec.phase === 'cleared') {
    return finishTransition(root, rec, 'rolled_forward');
  }

  return {
    ok: false,
    action: 'none',
    message:
      `${TRANSITION_FILE} is unreadable (phase "${rec.phase}"). Inspect it, and the archive it ` +
      'names, before deleting it by hand; no files were moved.',
  };
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Stage a NEW story (`--story`), archiving a completed run first.
 *
 * Every decision is made before anything is written, so each refusal leaves the
 * root exactly as it was:
 *
 *   - an active, incomplete run is never replaced (same story: use --resume;
 *     different story: resume it, or archive it explicitly with new-run);
 *   - a root story.md the runner did not stage is never overwritten;
 *   - files that cannot be attributed to the old run stop the transition;
 *   - a failed Jira fetch or a failed archive changes nothing.
 *
 * @param {object} p
 * @param {string} p.root
 * @param {string} p.ref           a story file path or a Jira key
 * @param {object|null} p.context  the current context.json, if any
 * @param {boolean} p.complete     is the current run finished?
 * @param {(key: string, out: string) => number} p.fetchJira  exit status
 * @returns {{ok: boolean, code: number, message: string, runId?: string}}
 */
export function startNewStory({
  root = '.',
  ref,
  context,
  complete,
  fetchJira,
  now = new Date(),
}) {
  // resolve() handles relative and absolute refs alike (join() would turn an
  // absolute Windows path into "C:\ws\C:\story.md").
  const refPath = resolve(root, ref);
  const isJira = JIRA_KEY.test(ref) && !existsSync(refPath);
  if (!isJira && !existsSync(refPath)) {
    return {
      ok: false,
      code: 2,
      message: `--story "${ref}" is neither an existing file nor a Jira key.`,
    };
  }

  const rootStory = join(root, 'story.md');
  const rootStoryDigest = existsSync(rootStory) ? sha256File(rootStory) : null;
  const pending = readTransition(root);
  const currentId = context?.story?.id ?? null;

  // ---- decide, without writing ----------------------------------------
  let archiveFiles = [];
  if (context && !complete) {
    const same = isJira
      ? ref === currentId
      : rootStoryDigest !== null && sha256File(refPath) === rootStoryDigest;
    const who = currentId ?? 'the current story';
    return {
      ok: false,
      code: 1,
      message: same
        ? `${who} is already the active run, and it is not complete. Repeating --story does not ` +
          'reset it. Continue it with:\n  npm run pipeline -- --resume'
        : `A run for ${who} is active and not complete; refusing to replace it with "${ref}". ` +
          'story.md and context.json were not changed.\n' +
          '  Continue it:            npm run pipeline -- --resume\n' +
          `  Or archive it, then retry: npm run new-run -- ${currentId ?? '<story-id>'} --clear\n` +
          `                           npm run pipeline -- --story "${ref}"`,
    };
  }

  if (context && complete) {
    const { owned, unknown, outside } = classifyRootArtifacts(context, root);
    if (unknown.length || outside.length) {
      return {
        ok: false,
        code: 1,
        message:
          `Cannot archive the completed run of ${currentId}: these files cannot be attributed to ` +
          'it, so they will not be archived or removed automatically:\n  ' +
          [...unknown, ...outside.map((o) => `${o} (outside the repo)`)].join(
            '\n  '
          ) +
          '\nMove them (or archive the run they belong to), then retry. Nothing was changed.',
      };
    }
    archiveFiles = owned;
  } else {
    // No context: the only thing that may be replaced is a story the runner
    // itself staged and that nobody has edited since.
    const runnerStaged =
      pending?.phase === 'installed' &&
      pending.new_story?.digest === rootStoryDigest;
    if (rootStoryDigest && !runnerStaged) {
      const same = !isJira && sha256File(refPath) === rootStoryDigest;
      if (!same) {
        return {
          ok: false,
          code: 1,
          message:
            'story.md exists at the root but was not staged by the runner (or was edited since); ' +
            'refusing to overwrite it. Move it, or stage it itself with:\n' +
            '  npm run pipeline -- --story story.md',
        };
      }
    }
    if (runnerStaged && !isJira && sha256File(refPath) === rootStoryDigest) {
      return {
        ok: false,
        code: 1,
        message:
          'That story is already staged and waiting for the Analyst. Continue with:\n' +
          '  npm run pipeline -- --resume',
      };
    }
    const { unknown } = classifyRootArtifacts(null, root);
    if (unknown.length) {
      return {
        ok: false,
        code: 1,
        message:
          'These artifacts are at the root with no run to attribute them to:\n  ' +
          unknown.join('\n  ') +
          '\nThey would be mistaken for the new run. Move them, then retry. Nothing was changed.',
      };
    }
  }

  // ---- act ----------------------------------------------------------------
  const txid = newRunId(now).replace(/[^0-9A-Za-z-]/g, '');
  const stageAbs = stagingDir(root, txid);
  const stagedRel = posix(relative(resolve(root), join(stageAbs, 'story.md')));

  if (isJira) {
    const status = fetchJira(ref, join(stageAbs, 'story.md'));
    if (status !== 0 || !existsSync(join(stageAbs, 'story.md'))) {
      removeQuietly(stageAbs);
      return {
        ok: false,
        code: 2,
        message: `Fetching ${ref} failed (exit ${status}); nothing at the root was changed.`,
      };
    }
  } else {
    copyFileSync(refPath, join(stageAbs, 'story.md'));
  }

  const digest = sha256File(join(stageAbs, 'story.md'));
  const runId = newRunId(now, digest + txid);
  const rec = {
    txid,
    phase: 'staging',
    started_at: now.toISOString(),
    previous_run: context
      ? { story_id: currentId, run_id: context.run_id ?? null }
      : null,
    new_story: {
      source: isJira ? 'jira' : 'file',
      ref,
      story_key: isJira ? ref : null,
      staged_path: stagedRel,
      digest,
      run_id: runId,
    },
  };
  writeTransition(root, rec);

  if (archiveFiles.length) {
    const archived = archiveRun({
      root,
      storyId: currentId,
      context,
      files: archiveFiles,
      now,
    });
    if (!archived.ok) {
      removeTransition(root);
      return { ok: false, code: 2, message: archived.message };
    }
    rec.phase = 'archived';
    rec.archive_dir = archived.archiveDir;
    rec.archived_files = archived.manifest.files.map(({ path, sha256 }) => ({
      path,
      sha256,
    }));
    writeTransition(root, rec);
  } else {
    rec.archived_files = [];
  }

  const done = finishTransition(root, rec);
  return { ...done, code: done.ok ? 0 : 2, runId };
}

/**
 * The Analyst has produced context.json for a staged run. Accept it only if it
 * is that run: the staged run id preserved, the story unchanged since staging,
 * and (for a Jira story) the same key.
 */
export function adoptStagedContext(root, context, rec) {
  const problems = [];
  if (context?.run_id !== rec.new_story.run_id) {
    problems.push(
      `context.json run_id is "${context?.run_id ?? '(missing)'}", but the staged run is ` +
        `"${rec.new_story.run_id}". The Analyst must use the staged run id, not mint a new one.`
    );
  }
  const story = join(root, 'story.md');
  if (!existsSync(story) || sha256File(story) !== rec.new_story.digest) {
    problems.push(
      'story.md changed after it was staged; re-stage it with --story.'
    );
  }
  if (
    rec.new_story.story_key &&
    context?.story?.id !== rec.new_story.story_key
  ) {
    problems.push(
      `context.json story.id is "${context?.story?.id}", but the staged story is ${rec.new_story.story_key}.`
    );
  }
  if (problems.length) return { ok: false, message: problems.join('\n') };
  removeTransition(root);
  return {
    ok: true,
    message: `Adopted context.json for staged run ${rec.new_story.run_id}.`,
  };
}

/** Clear the verified archive's root copies and install the staged story. */
export function finishTransition(root, rec, action = 'completed') {
  rec.phase = 'cleared';
  writeTransition(root, rec);
  const { changed } = clearArchived(root, rec.archived_files ?? []);
  if (changed.length) {
    return {
      ok: false,
      action: 'none',
      message:
        `These root files changed after they were archived to ${rec.archive_dir}; they were ` +
        `left in place:\n  ${changed.join('\n  ')}\nMove them, then run the pipeline again to finish.`,
    };
  }

  const staged = join(root, rec.new_story.staged_path);
  if (!existsSync(staged) || sha256File(staged) !== rec.new_story.digest) {
    return {
      ok: false,
      action: 'none',
      message: `The staged story at ${rec.new_story.staged_path} is missing or changed; cannot install it.`,
    };
  }
  copyFileSync(staged, join(root, 'story.md'));
  if (sha256File(join(root, 'story.md')) !== rec.new_story.digest) {
    return {
      ok: false,
      action: 'none',
      message: 'story.md did not install intact.',
    };
  }

  removeQuietly(join(root, STAGING_DIR));
  rec.phase = 'installed';
  delete rec.archived_files;
  writeTransition(root, rec);
  return {
    ok: true,
    action,
    message: rec.archive_dir
      ? `Previous run archived to ${rec.archive_dir}; new story installed.`
      : 'New story installed.',
  };
}
