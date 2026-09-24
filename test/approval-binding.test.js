// Regression tests for approvals bound to their reviewed inputs (task group 4.3).
//
// A gate used to be a flag: once approved it stayed approved, whatever changed
// afterwards. Edit an expected value after Gate 2, rewrite the story after
// Gate 1, bump a dependency after Gate 4 -- the approval still read as current,
// and every downstream step and adapter trusted it.
//
// Acceptance (the plan): changing a test, an expected value, the story, or a
// relevant execution dependency makes the right approval stale; adding a Jira
// id does not; status inspection never mutates state; gate history is intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  bindingFor,
  findInvalidations,
  gateDigest,
  requireCurrentGate,
} from '../scripts/lib/approval-binding.js';
import { applyGateDecision } from '../scripts/run-pipeline.js';
import {
  runContext,
  validTestCases,
  writeCompletedRun,
} from './helpers/valid-run.js';

const REPO = process.cwd();

function repo() {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-bind-'));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const ctxOf = (dir) => JSON.parse(read(dir, 'context.json'));

function run(dir, script, args = []) {
  const r = spawnSync('node', [join('scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TESTLINK_API_KEY: '', TESTLINK_URL: '' },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function editTestCase(dir, change) {
  const p = join(dir, 'test-cases', 'OLD-1.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  change(doc.test_cases[0]);
  writeFileSync(p, JSON.stringify(doc));
}

function staleGates(dir) {
  return findInvalidations(ctxOf(dir), dir)
    .map((i) => i.gate)
    .sort();
}

// ------------------------------------------------------ what counts as change

test('an approved run with unchanged inputs has every approval current', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    assert.deepEqual(staleGates(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adding a Jira id, reformatting, or CRLF line endings changes nothing', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    editTestCase(dir, (c) => {
      c.external_ids = { jira: 'SK-99' };
      c.testlink_id = '4242';
    });
    const p = join(dir, 'test-cases', 'OLD-1.json');
    writeFileSync(
      p,
      JSON.stringify(JSON.parse(readFileSync(p, 'utf8')), null, 4)
    );
    writeFileSync(
      join(dir, 'story.md'),
      read(dir, 'story.md').replace(/\n/g, '\r\n')
    );
    assert.deepEqual(staleGates(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed expected value makes Gate 2 stale, and every later gate with it', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    editTestCase(dir, (c) => {
      c.expected_results = ['a different expected value'];
    });
    assert.deepEqual(staleGates(dir), [
      'code_reviewed',
      'specs_reviewed',
      'test_scope_reviewed',
    ]);
    const g2 = findInvalidations(ctxOf(dir), dir).find(
      (i) => i.gate === 'test_scope_reviewed'
    );
    assert.deepEqual(g2.changed_inputs, ['test_cases']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed story or reinterpreted AC makes Gate 1 stale, cascading', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    writeFileSync(join(dir, 'story.md'), '# OLD-1\nA different story.\n');
    assert.deepEqual(staleGates(dir), [
      'code_reviewed',
      'requirements_reviewed',
      'specs_reviewed',
      'test_scope_reviewed',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed test or dependency lock makes Gate 4 stale only', () => {
  for (const [rel, content] of [
    ['tests/OLD-1.spec.ts', '// edited after review\n'],
    ['package-lock.json', '{"lockfileVersion":3}'],
    ['tests/fixtures/README.md', 'a changed fixture\n'],
  ]) {
    const dir = repo();
    try {
      writeCompletedRun(dir);
      writeFileSync(join(dir, rel), content);
      assert.deepEqual(staleGates(dir), ['code_reviewed'], rel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the digest covers run identity, not the approval object or timestamps', () => {
  const ctx = runContext();
  const d = gateDigest('requirements_reviewed', ctx, REPO);
  const reviewed = {
    ...ctx,
    review_gates: {
      ...ctx.review_gates,
      requirements_reviewed: {
        status: true,
        reviewed_at: '2030-01-01T00:00:00Z',
      },
    },
  };
  assert.equal(gateDigest('requirements_reviewed', reviewed, REPO), d);
  assert.notEqual(
    gateDigest(
      'requirements_reviewed',
      { ...ctx, run_id: 'another-run' },
      REPO
    ),
    d
  );
});

test('a legacy approval (no binding) needs re-review', () => {
  const ctx = runContext();
  const inv = findInvalidations(ctx, REPO);
  assert.ok(inv.length > 0);
  assert.match(inv[0].reason, /before approvals were bound/);
});

// -------------------------------------------------- the decision recorder --

test('an approval records its binding; a rejection records none', () => {
  const ctx = runContext({ status: 'draft', gates: false });
  const binding = bindingFor('requirements_reviewed', ctx, REPO);
  applyGateDecision(ctx, 'requirements_reviewed', {
    decision: 'approved',
    reviewer: 'alice',
    notes: null,
    openedAt: '2026-09-01T00:00:00Z',
    decidedAt: '2026-09-01T00:05:00Z',
    bindings: { requirements_reviewed: binding },
  });
  assert.equal(
    ctx.review_gates.requirements_reviewed.input_digest,
    binding.input_digest
  );

  applyGateDecision(ctx, 'specs_reviewed', {
    decision: 'rejected',
    reviewer: 'bob',
    notes: 'no',
    openedAt: '2026-09-01T00:00:00Z',
    decidedAt: '2026-09-01T00:05:00Z',
    bindings: { specs_reviewed: bindingFor('specs_reviewed', ctx, REPO) },
  });
  assert.equal(ctx.review_gates.specs_reviewed.input_digest, undefined);
});

// ------------------------------------------------------ the runner, resumed

test('resume returns stale approvals to pending, records why, keeps the history', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, { status: 'in_progress' });
    const ctx = ctxOf(dir);
    ctx.gate_decisions = [
      {
        gate: 'test_scope_reviewed',
        decision: 'approved',
        opened_at: '2026-09-01T00:00:00Z',
        decided_at: '2026-09-01T00:05:00Z',
        reviewer: 'h',
        notes: null,
      },
    ];
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
    editTestCase(dir, (c) => {
      c.expected_results = ['changed after approval'];
    });

    const r = run(dir, 'run-pipeline.js', ['--resume']);
    assert.match(r.out, /Approvals returned to pending/);
    assert.match(r.out, /GATE PENDING: test_scope_reviewed/);

    const after = ctxOf(dir);
    assert.equal(after.review_gates.test_scope_reviewed.status, false);
    assert.equal(
      after.review_gates.requirements_reviewed.status,
      true,
      'Gate 1 unaffected'
    );
    // History intact; no invented rejection.
    assert.deepEqual(after.gate_decisions, ctx.gate_decisions);
    const events = after.gate_invalidations.map((e) => e.gate).sort();
    assert.deepEqual(events, [
      'code_reviewed',
      'specs_reviewed',
      'test_scope_reviewed',
    ]);
    const g2 = after.gate_invalidations.find(
      (e) => e.gate === 'test_scope_reviewed'
    );
    assert.deepEqual(g2.changed_inputs, ['test_cases']);
    assert.equal(g2.previous_reviewer, 'h');
    // The context is still schema-valid.
    assert.equal(
      run(dir, 'validate-json.js', [
        'schemas/context.schema.json',
        'context.json',
      ]).code,
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--status reports a stale approval and never writes', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    writeFileSync(join(dir, 'tests', 'OLD-1.spec.ts'), '// edited\n');
    const before = read(dir, 'context.json');
    const r = run(dir, 'run-pipeline.js', ['--status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Stale approval: code_reviewed/);
    assert.match(r.out, /G4 pending/);
    assert.equal(read(dir, 'context.json'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a completed run whose approval went stale is no longer complete', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    assert.match(
      run(dir, 'run-pipeline.js', ['--status']).out,
      /Next step: done/
    );
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    assert.doesNotMatch(
      run(dir, 'run-pipeline.js', ['--status']).out,
      /Next step: done/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------ the lite consolidated gate

test('lite: a stale consolidated approval returns BOTH underlying gates to pending', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, { status: 'in_progress' });
    const ctx = ctxOf(dir);
    ctx.track = 'lite';
    ctx.review_gates.qa_scope_approved = {
      status: true,
      reviewer: 'h',
      reviewed_at: '2026-09-01T00:00:00Z',
    };
    for (const g of [
      'qa_scope_approved',
      'requirements_reviewed',
      'test_scope_reviewed',
      'specs_reviewed',
      'code_reviewed',
    ]) {
      ctx.review_gates[g] = {
        ...ctx.review_gates[g],
        status: true,
        ...bindingFor(g, ctx, dir),
      };
    }
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
    assert.deepEqual(staleGates(dir), []);

    // Changing the track changes the interpretation Gate 1 reviewed.
    const moved = ctxOf(dir);
    moved.track = 'standard';
    writeFileSync(join(dir, 'context.json'), JSON.stringify(moved, null, 2));
    const stale = staleGates(dir);
    for (const g of [
      'qa_scope_approved',
      'requirements_reviewed',
      'test_scope_reviewed',
    ]) {
      assert.ok(stale.includes(g), `${g} must be invalidated`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------- per-case decisions first

test('a scope gate does not prompt while test cases are still draft', () => {
  const dir = repo();
  try {
    const tc = validTestCases('OLD-1', 'old-run-1');
    tc.test_cases = tc.test_cases.map((c) => ({ ...c, status: 'draft' }));
    writeCompletedRun(
      dir,
      { status: 'in_progress' },
      {
        'test-cases/OLD-1.json': JSON.stringify(tc),
      }
    );
    const ctx = ctxOf(dir);
    for (const g of [
      'test_scope_reviewed',
      'specs_reviewed',
      'code_reviewed',
    ]) {
      ctx.review_gates[g] = false;
    }
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
    const r = run(dir, 'run-pipeline.js', ['--resume']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /still "draft"/);
    assert.doesNotMatch(r.out, /GATE PENDING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------ entry points outside the runner (box 7)

test('the classifier refuses a stale Gate 4', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    writeFileSync(
      join(dir, 'tests', 'OLD-1.spec.ts'),
      '// edited after review\n'
    );
    const r = run(dir, 'run-failure-classifier.js');
    assert.equal(r.code, 2, r.out);
    assert.match(
      r.out,
      /Gate 4: code_reviewed is stale: generated_test changed/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requireCurrentGate: current, stale and legacy approvals', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    assert.equal(
      requireCurrentGate(ctxOf(dir), 'test_scope_reviewed', dir).ok,
      true
    );
    // A Jira id written back by an adapter keeps Gate 2 current...
    editTestCase(dir, (c) => {
      c.external_ids = { jira: 'SK-1' };
    });
    assert.equal(
      requireCurrentGate(ctxOf(dir), 'test_scope_reviewed', dir).ok,
      true
    );
    // ...a changed priority does not.
    editTestCase(dir, (c) => {
      c.priority = c.priority === 'high' ? 'low' : 'high';
    });
    const stale = requireCurrentGate(ctxOf(dir), 'test_scope_reviewed', dir);
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /stale: test_cases changed/);

    const legacy = {
      ...ctxOf(dir),
      review_gates: { test_scope_reviewed: true },
    };
    assert.match(
      requireCurrentGate(legacy, 'test_scope_reviewed', dir).reason,
      /before approvals were bound/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
