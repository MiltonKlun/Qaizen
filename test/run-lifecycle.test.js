// Regression tests for the run lifecycle (task group 4.1, finding B3).
//
// B3: `--story` staged story.md FIRST and loaded the existing context.json
// SECOND. Reproduced on a completed run: `--story new-story.md` printed
// "Run complete: release report produced, all gates passed" while story.md
// held the NEW story and context.json still carried the OLD run's four passed
// gates. A new story silently inherited approvals it never received.
//
// These drive the real runner and new-run in throwaway mini-repos, covering
// the plan's matrix: complete-old/new-story, incomplete-old/new-story, same
// story, local and Jira fetch failure, interrupted initialization, archive
// write failure, and filenames with spaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  archiveRun,
  classifyRootArtifacts,
  readTransition,
  sha256File,
  writeTransition,
  TRANSITION_FILE,
} from '../scripts/lib/run-lifecycle.js';
import { runContext, writeCompletedRun } from './helpers/valid-run.js';

const REPO = process.cwd();

// ---------------------------------------------------------------- fixtures --

/**
 * A mini-repo holding a GENUINELY completed run of OLD-1 (valid, owned
 * artifacts; see test/helpers/valid-run.js) plus a new story file. `run`
 * overrides the run's state, e.g. { status: 'in_progress', gates: false }.
 */
function repo({ run = {}, prefix = '.tmp-runner-life-' } = {}) {
  const dir = mkdtempSync(join(REPO, prefix));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  writeCompletedRun(dir, run);
  writeFileSync(join(dir, 'new-story.md'), '# NEW-2\nA brand new story.\n');
  return dir;
}

function run(dir, script, args = [], env = {}) {
  const r = spawnSync('node', [join('scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JIRA_URL: '',
      JIRA_EMAIL: '',
      JIRA_API_TOKEN: '',
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const pipeline = (dir, ...args) => run(dir, 'run-pipeline.js', args);

/** A digest of every file under the root except the given prefixes. */
function snapshot(dir, skip = ['scripts', 'schemas']) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skip.includes(e.name)) continue;
      if (e.isDirectory()) walk(p);
      else out[p] = sha256File(join(dir, p));
    }
  };
  walk('');
  return out;
}

function archives(dir, story = 'OLD-1') {
  const d = join(dir, 'runs', story);
  return existsSync(d) ? readdirSync(d) : [];
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------- the flag contract --

test('--story with --resume, and --status with either, are refused before any write', () => {
  const dir = repo();
  try {
    const before = snapshot(dir);
    for (const args of [
      ['--story', 'new-story.md', '--resume'],
      ['--status', '--story', 'new-story.md'],
      ['--status', '--resume'],
      ['--story'],
    ]) {
      const r = pipeline(dir, ...args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    }
    assert.deepEqual(snapshot(dir), before, 'no file may change');
  } finally {
    cleanup(dir);
  }
});

// ------------------------------------------------ complete old, new story --

test('B3: a new story after a COMPLETED run archives it and reaches the Analyst', () => {
  const dir = repo();
  try {
    const owned = classifyRootArtifacts(runContext(), dir).owned;
    const digests = Object.fromEntries(
      owned.map((f) => [f, sha256File(join(dir, f))])
    );

    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 0, r.out);
    // The bug: this used to print "Run complete" for the OLD run.
    assert.doesNotMatch(r.out, /Run complete/);
    assert.match(r.out, /Next step: ANALYST/);

    // No inherited context, gates or output pointers.
    assert.equal(existsSync(join(dir, 'context.json')), false);
    assert.match(readFileSync(join(dir, 'story.md'), 'utf8'), /NEW-2/);

    // A new, unique run identity the Analyst is told to keep.
    const rec = readTransition(dir);
    assert.equal(rec.phase, 'installed');
    assert.notEqual(rec.new_story.run_id, 'old-run-1');
    assert.equal(rec.new_story.digest, sha256File(join(dir, 'story.md')));
    assert.match(r.out, new RegExp(`Use run_id "${rec.new_story.run_id}"`));

    // The old run is archived byte-for-byte: exactly its own files.
    const [archive] = archives(dir);
    const manifest = JSON.parse(
      readFileSync(
        join(dir, 'runs', 'OLD-1', archive, 'run-manifest.json'),
        'utf8'
      )
    );
    assert.deepEqual(manifest.archived_files.sort(), owned);
    for (const f of manifest.files) {
      assert.equal(f.sha256, digests[f.path], `${f.path} digest`);
      assert.equal(
        sha256File(join(dir, 'runs', 'OLD-1', archive, f.path)),
        digests[f.path]
      );
    }
    assert.equal(manifest.status_at_archive, 'completed');
  } finally {
    cleanup(dir);
  }
});

test('reusable files, reports and .gitkeep are never archived or removed', () => {
  const dir = repo();
  try {
    pipeline(dir, '--story', 'new-story.md');
    for (const f of [
      'tests/seed.spec.ts',
      'tests/fixtures/README.md',
      'test-cases/.gitkeep',
      'reports/results.json',
    ]) {
      assert.equal(
        existsSync(join(dir, f)),
        true,
        `${f} must stay at the root`
      );
    }
    const [archive] = archives(dir);
    const archived = JSON.parse(
      readFileSync(
        join(dir, 'runs', 'OLD-1', archive, 'run-manifest.json'),
        'utf8'
      )
    ).archived_files;
    for (const f of [
      'tests/seed.spec.ts',
      'tests/fixtures/README.md',
      'test-cases/.gitkeep',
      'reports/results.json',
    ]) {
      assert.equal(archived.includes(f), false, `${f} must not be archived`);
    }
  } finally {
    cleanup(dir);
  }
});

test('archived artifacts are NOT reformatted: the bytes match the source', () => {
  const dir = repo();
  try {
    const src = readFileSync(join(dir, 'test-cases', 'OLD-1.json'));
    pipeline(dir, '--story', 'new-story.md');
    const [archive] = archives(dir);
    const copy = readFileSync(
      join(dir, 'runs', 'OLD-1', archive, 'test-cases', 'OLD-1.json')
    );
    assert.equal(Buffer.compare(copy, src), 0);
  } finally {
    cleanup(dir);
  }
});

test('the Analyst must keep the staged run id; the matching context is adopted', () => {
  const dir = repo();
  try {
    pipeline(dir, '--story', 'new-story.md');
    const rec = readTransition(dir);
    const ctx = {
      ...runContext({ status: 'draft', gates: false, storyId: 'NEW-2' }),
    };

    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ ...ctx, run_id: 'minted-by-analyst' })
    );
    const wrong = pipeline(dir, '--resume');
    assert.equal(wrong.code, 2, wrong.out);
    assert.match(wrong.out, /must use the staged run id/);
    assert.equal(
      readTransition(dir).phase,
      'installed',
      'the record survives a refusal'
    );

    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ ...ctx, run_id: rec.new_story.run_id })
    );
    const right = pipeline(dir, '--resume');
    assert.match(right.out, /Adopted context\.json for staged run/);
    assert.equal(existsSync(join(dir, TRANSITION_FILE)), false);
  } finally {
    cleanup(dir);
  }
});

// --------------------------------------------- incomplete old, new story --

test('a new story never replaces an INCOMPLETE run, and nothing is written', () => {
  const dir = repo({ run: { status: 'in_progress', gates: false } });
  try {
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /OLD-1 is active and not complete/);
    assert.match(r.out, /--resume/);
    assert.match(r.out, /new-run -- OLD-1 --clear/);
    assert.deepEqual(
      snapshot(dir),
      before,
      'story.md and context.json unchanged'
    );
  } finally {
    cleanup(dir);
  }
});

test('repeating the SAME story on an incomplete run is not a silent reset', () => {
  const dir = repo({ run: { status: 'in_progress', gates: false } });
  try {
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'story.md');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /does not reset it/);
    assert.match(r.out, /--resume/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('an incomplete run can be set aside explicitly with new-run --clear', () => {
  const dir = repo({ run: { status: 'in_progress', gates: false } });
  try {
    const cleared = run(dir, 'new-run.js', ['OLD-1', '--clear']);
    assert.equal(cleared.code, 0, cleared.out);
    assert.equal(existsSync(join(dir, 'context.json')), false);
    assert.equal(existsSync(join(dir, 'tests', 'seed.spec.ts')), true);

    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Next step: ANALYST/);
  } finally {
    cleanup(dir);
  }
});

// --------------------------------------------------------- fetch failures --

test('a missing local story file changes nothing', () => {
  const dir = repo();
  try {
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'no-such-story.md');
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('a failed Jira fetch leaves the completed run current and untouched', () => {
  const dir = repo();
  try {
    const before = snapshot(dir);
    // No Jira credentials in the environment: the read-only fetch fails.
    const r = pipeline(dir, '--story', 'NOPE-404');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Fetching NOPE-404 failed/);
    assert.deepEqual(
      snapshot(dir),
      before,
      'no archive, no record, root intact'
    );
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------- write failures, stops --

test('an archive write failure preserves the old run and leaves no record', () => {
  const dir = repo();
  try {
    // runs/ is a FILE, so no archive directory can be created under it.
    writeFileSync(join(dir, 'runs'), 'not a directory');
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /nothing at the root was changed/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('a file that cannot be attributed to the old run is an actionable stop', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'test-cases', 'SOMEONE-ELSE-9.json'), '{}');
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /test-cases\/SOMEONE-ELSE-9\.json/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('a story.md the runner did not stage is never overwritten', () => {
  const dir = repo();
  try {
    unlinkSync(join(dir, 'context.json'));
    for (const d of [
      'test-cases',
      'planner-input',
      'specs',
      'analysis',
      'release',
    ]) {
      rmSync(join(dir, d), { recursive: true, force: true });
    }
    unlinkSync(join(dir, 'tests', 'OLD-1.spec.ts'));
    const before = snapshot(dir);
    const r = pipeline(dir, '--story', 'new-story.md');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /refusing to overwrite it/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

// --------------------------------------------- interrupted initialization --

/** Put the mini-repo in the state an interrupted transition leaves behind. */
function interrupted(dir, phase) {
  const ctx = runContext();
  const { owned } = classifyRootArtifacts(ctx, dir);
  mkdirSync(join(dir, '.qaizen', 'staging', 'tx1'), { recursive: true });
  const staged = join(dir, '.qaizen', 'staging', 'tx1', 'story.md');
  writeFileSync(staged, readFileSync(join(dir, 'new-story.md')));
  const archived = archiveRun({
    root: dir,
    storyId: 'OLD-1',
    context: ctx,
    files: owned,
  });
  assert.equal(archived.ok, true, archived.message);
  const rec = {
    txid: 'tx1',
    phase,
    new_story: {
      source: 'file',
      ref: 'new-story.md',
      story_key: null,
      staged_path: '.qaizen/staging/tx1/story.md',
      digest: sha256File(staged),
      run_id: '2026-09-22T00-00-00Z-abcdef0',
    },
    archive_dir: archived.archiveDir,
    archived_files: archived.manifest.files.map(({ path, sha256 }) => ({
      path,
      sha256,
    })),
  };
  writeTransition(dir, rec);
  return archived.archiveDir;
}

test('interrupted while STAGING: rolled back, the old run is still current', () => {
  const dir = repo();
  try {
    const archiveDir = interrupted(dir, 'staging');
    const r = pipeline(dir, '--resume');
    assert.match(r.out, /Rolled back an interrupted new-story transition/);
    assert.equal(
      existsSync(join(dir, archiveDir)),
      false,
      'partial archive removed'
    );
    assert.equal(existsSync(join(dir, 'context.json')), true);
    assert.match(readFileSync(join(dir, 'story.md'), 'utf8'), /OLD-1/);
    assert.equal(readTransition(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('interrupted after ARCHIVING, and midway through CLEARING: rolled forward', () => {
  for (const partial of [false, true]) {
    const dir = repo();
    try {
      const archiveDir = interrupted(dir, partial ? 'cleared' : 'archived');
      if (partial) unlinkSync(join(dir, 'specs', 'OLD-1.md')); // half-cleared
      const r = pipeline(dir, '--resume');
      assert.match(r.out, /Previous run archived to/, r.out);
      assert.equal(existsSync(join(dir, archiveDir, 'context.json')), true);
      assert.equal(existsSync(join(dir, 'context.json')), false);
      assert.match(readFileSync(join(dir, 'story.md'), 'utf8'), /NEW-2/);
      assert.equal(readTransition(dir).phase, 'installed');
      assert.match(r.out, /Next step: ANALYST/);
    } finally {
      cleanup(dir);
    }
  }
});

test('--status reports a pending transition but never recovers it', () => {
  const dir = repo();
  try {
    interrupted(dir, 'archived');
    const before = snapshot(dir);
    const r = pipeline(dir, '--status');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /interrupted new-story transition is pending/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    cleanup(dir);
  }
});

// ------------------------------------------------------------------ spaces --

test('paths with spaces work end to end', () => {
  const dir = repo({ prefix: '.tmp-runner-with space-' });
  try {
    writeFileSync(
      join(dir, 'my new story.md'),
      '# NEW-3\nSpaces in the name.\n'
    );
    const r = pipeline(dir, '--story', 'my new story.md');
    assert.equal(r.code, 0, r.out);
    assert.match(readFileSync(join(dir, 'story.md'), 'utf8'), /NEW-3/);
    assert.equal(archives(dir).length, 1);
  } finally {
    cleanup(dir);
  }
});

// ------------------------------------------------------------------ new-run --

test('new-run archives only the run, verified, and refuses unattributable files', () => {
  const dir = repo();
  try {
    const r = run(dir, 'new-run.js', ['OLD-1']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified by SHA-256/);
    // Without --clear the root is untouched.
    assert.equal(existsSync(join(dir, 'context.json')), true);

    writeFileSync(join(dir, 'specs', 'STRAY-5.md'), 'x');
    const stop = run(dir, 'new-run.js', ['OLD-1']);
    assert.equal(stop.code, 1, stop.out);
    assert.match(stop.out, /specs\/STRAY-5\.md/);
  } finally {
    cleanup(dir);
  }
});
