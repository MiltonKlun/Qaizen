// Regression tests for the "misleading success" paths (task group 1.2).
//
// Three real defects, each of which made missing or unverified work look like a
// pass:
//   I1 — sync-testlink-execution.js reported Pass for any linked case with no
//        failure entry, i.e. from the ABSENCE of evidence.
//   I5 — evaluate-agents.js exited 0 for a missing candidate directory, and
//        scored 100% for a candidate that had no test cases at all.
//   S3 — run-healer.js claimed to enforce guardrails it cannot currently reach.
//
// These drive the real scripts as subprocesses against synthetic fixtures in
// temp directories, so nothing in the repo is mutated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { bindGate } from './helpers/valid-run.js';

/** Run a repo script from the repo root; return { code, out }. */
function run(args, opts = {}) {
  const r = spawnSync(execPath, args, {
    encoding: 'utf8',
    // Clear inherited integration credentials: these tests must never reach a
    // real Jira/TestLink, and an inherited token could change behaviour.
    env: {
      ...process.env,
      TESTLINK_API_KEY: '',
      TESTLINK_URL: '',
      JIRA_API_TOKEN: '',
      REQRES_API_KEY: '',
      ...(opts.env || {}),
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `qaizen-${prefix}-`));
}

/**
 * Replace the workspace's Gate 4 with a real, BOUND approval of what it now
 * contains (task group 4.3). A bare `code_reviewed: true` is a legacy
 * approval the TestLink sync now refuses. Call after the workspace is written.
 */
function bindGate4(dir) {
  const p = join(dir, 'context.json');
  const ctx = bindGate(
    JSON.parse(readFileSync(p, 'utf8')),
    'code_reviewed',
    dir
  );
  writeFileSync(p, JSON.stringify(ctx));
}

// --- I5: the evaluator must not turn missing work into a high score --------

const VALID_CONTEXT = {
  schema_version: '1.0',
  run_id: '2026-01-01T00-00-00Z-test',
  story: { id: 'STORY-777', source: 'manual', path: 'story.md' },
  acceptance_criteria: ['The footer shows the current year.'],
  ambiguities: [],
  risks: [
    {
      risk_id: 'RISK-001',
      description: 'A stale year looks unmaintained.',
      severity: 'low',
      related_acs: [0],
    },
  ],
  artifact_paths: {},
  review_gates: {},
  status: 'draft',
};

function candidateWithContextOnly() {
  const dir = scratch('eval-ctx-only');
  writeFileSync(join(dir, 'context.json'), JSON.stringify(VALID_CONTEXT));
  return dir;
}

test('evaluate-agents: a missing candidate directory fails (never a silent 0 stories, exit 0)', () => {
  const out = join(scratch('eval-out'), 'results.json');
  const r = run([
    'scripts/evaluate-agents.js',
    '--candidate-dir',
    join(tmpdir(), 'qaizen-definitely-not-a-real-candidate-dir'),
    '--out',
    out,
  ]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Candidate directory not found/);
});

test('evaluate-agents: a candidate with no context.json fails', () => {
  const dir = scratch('eval-empty');
  const out = join(scratch('eval-out'), 'results.json');
  try {
    const r = run([
      'scripts/evaluate-agents.js',
      '--candidate-dir',
      dir,
      '--out',
      out,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /no context\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluate-agents: context-only candidate FAILS by default (designer stage)', () => {
  // The original defect: this scored 100% because the test-case checks were
  // skipped when the file was absent.
  const dir = candidateWithContextOnly();
  const out = join(scratch('eval-out'), 'results.json');
  try {
    const r = run([
      'scripts/evaluate-agents.js',
      '--candidate-dir',
      dir,
      '--out',
      out,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /missing required test cases/);
    assert.doesNotMatch(r.out, /Overall: 100%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluate-agents: context-only candidate is scorable ONLY in explicit analyst stage', () => {
  const dir = candidateWithContextOnly();
  const out = join(scratch('eval-out'), 'results.json');
  try {
    const r = run([
      'scripts/evaluate-agents.js',
      '--candidate-dir',
      dir,
      '--stage',
      'analyst',
      '--out',
      out,
    ]);
    // It scores (exit 0 or 1 depending on the context's own checks), but it
    // must NOT be rejected for missing test cases.
    assert.doesNotMatch(r.out, /missing required test cases/);
    assert.match(r.out, /Scored: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluate-agents: malformed flags are usage errors', () => {
  const bare = run(['scripts/evaluate-agents.js', '--candidate-dir']);
  assert.equal(bare.code, 2, bare.out);
  assert.match(bare.out, /--candidate-dir requires a directory path/);

  const badStage = run([
    'scripts/evaluate-agents.js',
    '--candidate-dir',
    tmpdir(),
    '--stage',
    'nonsense',
  ]);
  assert.equal(badStage.code, 2, badStage.out);
  assert.match(badStage.out, /--stage must be/);
});

test('evaluate-agents: dataset mode still scores the committed expected outputs', () => {
  // Guards against the fix over-rejecting: the normal dataset run must survive.
  const out = join(scratch('eval-out'), 'results.json');
  const r = run(['scripts/evaluate-agents.js', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Overall: 100%/);
});

// --- I1: absence of a failure is not a pass --------------------------------

test('testlink-status-map: not_run maps to Not Run, and nothing maps absence to Pass', async () => {
  const { readFileSync } = await import('node:fs');
  const map = JSON.parse(
    readFileSync('config/testlink-status-map.json', 'utf8')
  );
  const byOutcome = map.outcome_to_testlink_status;
  assert.equal(byOutcome.not_run, 'Not Run', 'not_run must map to Not Run');
  assert.equal(byOutcome.skipped, 'Not Run');
  // Pass must remain reachable only from a genuine passed outcome.
  const passKeys = Object.entries(byOutcome)
    .filter(([, v]) => v === 'Pass')
    .map(([k]) => k);
  assert.deepEqual(
    passKeys,
    ['passed'],
    `only "passed" may map to Pass, got: ${passKeys.join(', ')}`
  );
  assert.equal(map.default_status, 'Blocked');
});

test('sync-testlink-execution: a linked case with no failure entry is NOT reported as Pass', async () => {
  const { copyFileSync } = await import('node:fs');
  const dir = scratch('tl-exec');
  try {
    mkdirSync(join(dir, 'test-cases'), { recursive: true });
    mkdirSync(join(dir, 'analysis'), { recursive: true });
    mkdirSync(join(dir, 'config'), { recursive: true });
    // The script resolves its inputs relative to cwd, so the fixture needs the
    // real status map and a context whose Gate 4 is recorded as reviewed.
    copyFileSync(
      join(process.cwd(), 'config', 'testlink-status-map.json'),
      join(dir, 'config', 'testlink-status-map.json')
    );
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({
        schema_version: '1.0',
        story: { id: 'STORY-777' },
        review_gates: { code_reviewed: true },
      })
    );
    // Two approved, linked cases: one manual, one intentionally skipped.
    // Neither has a failure entry and there is NO execution evidence at all.
    writeFileSync(
      join(dir, 'test-cases', 'STORY-777.json'),
      JSON.stringify({
        schema_version: '1.0',
        story_id: 'STORY-777',
        test_cases: [
          {
            test_case_id: 'TC-001',
            automation_decision: 'manual',
            status: 'approved',
            testlink_id: '101',
          },
          {
            test_case_id: 'TC-002',
            automation_decision: 'skip',
            status: 'approved',
            testlink_id: '102',
          },
        ],
      })
    );
    writeFileSync(
      join(dir, 'analysis', 'failure-analysis.json'),
      JSON.stringify({ schema_version: '1.0', failures: [] })
    );

    bindGate4(dir);
    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sync-testlink-execution.js'
    );
    const r = spawnSync(execPath, [scriptPath, 'STORY-777'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TESTLINK_API_KEY: '', TESTLINK_URL: '' },
    });
    const out = (r.stdout || '') + (r.stderr || '');

    // The dry-run plan must not propose Pass for either case.
    assert.doesNotMatch(
      out,
      /Pass \(p\)/,
      `no execution evidence must never plan a Pass:\n${out}`
    );
    // And the conservative outcomes should be visible.
    assert.match(out, /not_run|Not Run|skipped/i, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3.3: a draft analysis is never pushed as a result ----------------------

function syncTestlinkWith(fa) {
  const dir = scratch('tl-draft');
  mkdirSync(join(dir, 'test-cases'), { recursive: true });
  mkdirSync(join(dir, 'analysis'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'testlink-status-map.json'),
    readFileSync(join(process.cwd(), 'config', 'testlink-status-map.json'))
  );
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify({
      schema_version: '1.0',
      story: { id: 'STORY-777' },
      review_gates: { code_reviewed: true },
    })
  );
  writeFileSync(
    join(dir, 'test-cases', 'STORY-777.json'),
    JSON.stringify({
      schema_version: '1.0',
      story_id: 'STORY-777',
      test_cases: [
        {
          test_case_id: 'TC-001',
          automation_decision: 'automate_e2e',
          status: 'approved',
          testlink_id: '101',
        },
      ],
    })
  );
  writeFileSync(
    join(dir, 'analysis', 'failure-analysis.json'),
    JSON.stringify(fa)
  );
  bindGate4(dir);
  const r = spawnSync(
    execPath,
    [join(process.cwd(), 'scripts', 'sync-testlink-execution.js'), 'STORY-777'],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TESTLINK_API_KEY: '', TESTLINK_URL: '' },
    }
  );
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('sync-testlink-execution: a 2.x DRAFT analysis is refused, a finalized one is not', () => {
  const failure = {
    failure_id: 'FAIL-001',
    test_case_id: 'TC-001',
    classification: 'product_bug',
    severity: 'red',
  };
  const draft = syncTestlinkWith({
    schema_version: '2.0',
    status: 'draft',
    failures: [failure],
  });
  assert.equal(draft.code, 1, draft.out);
  assert.match(draft.out, /refusing to sync execution results/);
  // Nothing from the draft may be planned as a result.
  assert.doesNotMatch(draft.out, /Fail \(f\)/);

  const finalized = syncTestlinkWith({
    schema_version: '2.0',
    status: 'finalized',
    failures: [{ ...failure, bug_draft_path: 'release/bug-drafts/BUG-001.md' }],
  });
  assert.doesNotMatch(finalized.out, /refusing to sync/, finalized.out);
});

// --- S3: the healer must not claim enforcement it cannot perform -----------

test('run-healer: output describes triage scaffolding, not enforced guardrails', () => {
  const r = run(['scripts/run-healer.js']);
  // It may exit 2 when there is no failure-analysis in the repo root; either
  // way it must never claim the guardrails are enforced in code.
  assert.doesNotMatch(
    r.out,
    /Guardrails enforced in code/,
    `stale enforcement claim still present:\n${r.out}`
  );
});
