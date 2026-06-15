// Tests for the thin gated runner (IMPROVEMENT-PLAN IP-2.4). Two layers:
//
// 1. Unit: applyGateDecision — the decision recorder the interactive CLI
//    calls after a human answers on a real TTY. Testing it by import does
//    NOT create a non-interactive approval path: the CLI still hard-checks
//    stdin.isTTY before it ever asks, and has no flag to inject a decision.
//
// 2. Black-box: the runner spawned as a subprocess in a throwaway mini-repo
//    (created INSIDE the project root so `node` can resolve ajv from the
//    real node_modules when the runner spawns the generic validator).
//    Asserts: --status read-only reporting, resume idempotence, the
//    forbidden-flag guard, the blocked-ambiguity halt, and the load-bearing
//    one — NON-TTY REFUSAL: with piped stdin at a gate, the runner prints
//    GATE PENDING and exits non-zero without touching context.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { applyGateDecision } from '../scripts/run-pipeline.js';
import { gatePassed } from '../scripts/pipeline-state.js';

// ---------------------------------------------------------------- helpers --

function freshContext(overrides = {}) {
  return {
    schema_version: '1.0',
    run_id: 'test-run',
    story: { id: 'STORY-001', title: 't', source: 'manual', path: 'story.md' },
    acceptance_criteria: ['AC 1'],
    ambiguities: [],
    risks: [],
    artifact_paths: {
      test_cases: '',
      planner_brief: '',
      playwright_spec: '',
      generated_test: '',
      execution_results: '',
      html_report: '',
      traces: '',
      screenshots: '',
      failure_analysis: '',
      release_report_md: '',
      release_report_json: '',
      bug_drafts_dir: '',
    },
    review_gates: {
      requirements_reviewed: false,
      test_scope_reviewed: false,
      specs_reviewed: false,
      code_reviewed: false,
    },
    status: 'draft',
    ...overrides,
  };
}

// Build a throwaway mini-repo with the runner + validator + schema, INSIDE
// the project root (node_modules resolution walks up to the real one).
function makeMiniRepo() {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-runner-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  for (const f of [
    'run-pipeline.js',
    'pipeline-state.js',
    'gate-briefs.js',
    'validate-json.js',
    'track-floor.js',
    'red-domains.js',
    'gate4-scan.js',
    'healer-guardrails.js',
  ]) {
    copyFileSync(join('scripts', f), join(dir, 'scripts', f));
  }
  copyFileSync(
    join('schemas', 'context.schema.json'),
    join(dir, 'schemas', 'context.schema.json')
  );
  return dir;
}

// Spawn the runner inside the mini-repo with PIPED stdin (i.e. not a TTY).
function runPipeline(dir, args = []) {
  const r = spawnSync('node', ['scripts/run-pipeline.js', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ------------------------------------------------- unit: decision recorder --

test('applyGateDecision — approval writes the audit object + telemetry event', () => {
  const c = freshContext();
  applyGateDecision(c, 'requirements_reviewed', {
    decision: 'approved',
    reviewer: 'alice',
    notes: 'AC accurate',
    openedAt: '2026-06-10T10:00:00Z',
    decidedAt: '2026-06-10T10:07:00Z',
  });

  assert.deepEqual(c.review_gates.requirements_reviewed, {
    status: true,
    reviewer: 'alice',
    reviewed_at: '2026-06-10T10:07:00Z',
    opened_at: '2026-06-10T10:00:00Z',
    notes: 'AC accurate',
  });
  assert.equal(c.gate_decisions.length, 1);
  assert.deepEqual(c.gate_decisions[0], {
    gate: 'requirements_reviewed',
    decision: 'approved',
    opened_at: '2026-06-10T10:00:00Z',
    decided_at: '2026-06-10T10:07:00Z',
    reviewer: 'alice',
    notes: 'AC accurate',
  });
  // Gate 1 approval moves the run out of draft.
  assert.equal(c.status, 'in_progress');
  assert.equal(gatePassed(c.review_gates.requirements_reviewed), true);
});

test('applyGateDecision — rejection records history but the gate stays unpassed', () => {
  const c = freshContext();
  applyGateDecision(c, 'specs_reviewed', {
    decision: 'rejected',
    reviewer: 'bob',
    notes: 'wrong flow explored',
    openedAt: '2026-06-10T11:00:00Z',
    decidedAt: '2026-06-10T11:05:00Z',
  });

  assert.equal(gatePassed(c.review_gates.specs_reviewed), false);
  assert.equal(c.review_gates.specs_reviewed.status, false);
  assert.equal(c.gate_decisions[0].decision, 'rejected');
  assert.equal(c.gate_decisions[0].notes, 'wrong flow explored');
  // A rejection never advances the run state.
  assert.equal(c.status, 'draft');
});

test('applyGateDecision — output validates against the context schema', () => {
  const dir = makeMiniRepo();
  try {
    const c = freshContext();
    applyGateDecision(c, 'requirements_reviewed', {
      decision: 'approved',
      reviewer: 'alice',
      notes: null,
      openedAt: '2026-06-10T10:00:00Z',
      decidedAt: '2026-06-10T10:07:00Z',
    });
    const p = join(dir, 'context.json');
    writeFileSync(p, JSON.stringify(c, null, 2));
    const r = spawnSync(
      'node',
      ['scripts/validate-json.js', 'schemas/context.schema.json', p],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ black-box: runner --

test('runner --status with no context reports the analyst entry point', () => {
  const dir = makeMiniRepo();
  try {
    const r = runPipeline(dir, ['--status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /No run in progress/);
    assert.match(r.out, /analyst/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner --status reports gate state and next step (read-only)', () => {
  const dir = makeMiniRepo();
  try {
    const ctxPath = join(dir, 'context.json');
    writeFileSync(ctxPath, JSON.stringify(freshContext(), null, 2));
    const before = readFileSync(ctxPath, 'utf8');

    const r = runPipeline(dir, ['--status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /G1 pending/);
    assert.match(r.out, /Next step: gate1/);
    assert.equal(
      readFileSync(ctxPath, 'utf8'),
      before,
      '--status must not write'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NON-TTY REFUSAL — piped stdin at a gate: GATE PENDING, non-zero, no writes', () => {
  const dir = makeMiniRepo();
  try {
    const ctxPath = join(dir, 'context.json');
    writeFileSync(ctxPath, JSON.stringify(freshContext(), null, 2));
    const before = readFileSync(ctxPath, 'utf8');

    const r = runPipeline(dir, []); // next step is gate1; stdin is a pipe
    assert.notEqual(r.code, 0, 'a pending gate must exit non-zero');
    assert.match(r.out, /GATE PENDING: requirements_reviewed/);
    assert.equal(
      readFileSync(ctxPath, 'utf8'),
      before,
      'refusing a gate must not modify context.json'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume idempotence — re-running at the same gate changes nothing', () => {
  const dir = makeMiniRepo();
  try {
    const ctxPath = join(dir, 'context.json');
    writeFileSync(ctxPath, JSON.stringify(freshContext(), null, 2));

    const first = runPipeline(dir, ['--resume']);
    const second = runPipeline(dir, ['--resume']);
    assert.equal(first.out, second.out, 'same state -> same output');
    assert.notEqual(first.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forbidden flags — any gate-deciding flag is refused outright (exit 2)', () => {
  const dir = makeMiniRepo();
  try {
    for (const flag of ['--approve', '--gate', '--reject', '--decision']) {
      const r = runPipeline(dir, [flag]);
      assert.equal(r.code, 2, `${flag}: ${r.out}`);
      assert.match(r.out, /interactive-only/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocking ambiguity halts the runner before any step (CLAUDE.md §3.7)', () => {
  const dir = makeMiniRepo();
  try {
    const ctx = freshContext({
      ambiguities: [
        { description: 'is the discount stackable?', blocking: true },
      ],
    });
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

    const r = runPipeline(dir, []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /BLOCKED/);
    assert.match(r.out, /is the discount stackable\?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent step guidance — gate passed leads to the next agent instruction', () => {
  const dir = makeMiniRepo();
  try {
    const ctx = freshContext();
    ctx.review_gates.requirements_reviewed = {
      status: true,
      reviewer: 'alice',
      reviewed_at: '2026-06-10T10:07:00Z',
      opened_at: '2026-06-10T10:00:00Z',
      notes: null,
    };
    ctx.status = 'in_progress';
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

    const r = runPipeline(dir, []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /TEST DESIGNER/);
    assert.match(r.out, /agents\/test-designer\.md/);
    assert.match(r.out, /--resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- track floor enforcement (IMPROVEMENT-PLAN Phase 4, IP-4.6) -----------

test('runner REFUSES track:lite when the floor is higher (red domain)', () => {
  const dir = makeMiniRepo();
  try {
    const ctx = freshContext({
      track: 'lite',
      story: {
        id: 'STORY-001',
        title: 'Process a refund payment to the card on file',
        source: 'manual',
        path: 'story.md',
      },
    });
    const before = JSON.stringify(ctx, null, 2);
    writeFileSync(join(dir, 'context.json'), before);

    const r = runPipeline(dir, []);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Refusing track "lite"/);
    assert.match(r.out, /floor for this story is "standard"/);
    assert.match(r.out, /red-domain/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner ALLOWS track:lite for a benign story (reaches the qa_scope gate)', () => {
  const dir = makeMiniRepo();
  try {
    // Benign, routine story: no red keywords, one low AC, no risks.
    const ctx = freshContext({
      track: 'lite',
      story: {
        id: 'STORY-001',
        title: 'Footer shows the current year',
        source: 'manual',
        path: 'story.md',
      },
      acceptance_criteria: ['The footer shows the current four-digit year.'],
      // cases already written so the next step is the consolidated gate
      artifact_paths: {
        test_cases: 'test-cases/STORY-001.json',
        planner_brief: '',
        playwright_spec: '',
        generated_test: '',
        execution_results: '',
        html_report: '',
        traces: '',
        screenshots: '',
        failure_analysis: '',
        release_report_md: '',
        release_report_json: '',
        bug_drafts_dir: '',
      },
    });
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

    const r = runPipeline(dir, []);
    // Not refused (would be exit 2 with "Refusing"); instead it reaches the
    // consolidated lite gate and halts there because stdin is piped.
    assert.ok(!/Refusing track/.test(r.out), r.out);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /GATE PENDING: qa_scope_approved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
