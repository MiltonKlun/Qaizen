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

// --- I1 / 3.3: execution results are reported only from evidence --------
// Covered by test/execution-sync.test.js (task group 5.3): the ledger-based
// outcome rules, the draft-analysis refusal, and the status-map guard.

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
