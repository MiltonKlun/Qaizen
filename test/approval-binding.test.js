// Regression tests for approvals bound to their reviewed inputs.
//
// A gate used to be a flag: once approved it stayed approved, whatever changed
// afterwards. Edit an expected value after Gate 2, rewrite the story after
// Gate 1, bump a dependency after Gate 4 -- the approval still read as current,
// and every downstream step and adapter trusted it.
//
// Acceptance: changing a test, an expected value, the story, or a
// relevant execution dependency makes the right approval stale; adding a Jira
// id does not; status inspection never mutates state; gate history is intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
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
  gateFiles,
  gateInputs,
  playwrightTestDir,
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

test('adding a Jira id or sync record, reformatting, or CRLF line endings changes nothing', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    editTestCase(dir, (c) => {
      c.external_ids = { jira: 'SK-99' };
      c.testlink_id = '4242';
      c.sync_state = {
        jira: {
          operation_key: 'jira:SK:OLD-1:TC-001:create_case',
          marker: 'qaizen-op-0123456789ab',
          state: 'created',
          remote_id: 'SK-99',
          intent_at: '2026-09-27T00:00:00Z',
        },
      };
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

// Files Gate 4 reviews beyond the generated test: a page object reached only
// through imports (outside the testDir), the helper it imports, the seed
// spec, tests/fixtures.ts, and the project files the test compiles under.
const CODE_FILES = {
  'tests/OLD-1.spec.ts':
    "import { LoginPage } from '../pages/login.page';\n// generated\n",
  'pages/login.page.ts':
    "import { base } from './base.js';\nexport class LoginPage {}\n",
  'pages/base.ts': 'export const base = 1;\n',
  'tests/fixtures.ts': 'export const fixture = 1;\n',
  'tests/.env.local': 'SECRET=never-bound\n',
  'tsconfig.json': '{ // comments are allowed\n  "compilerOptions": {}\n}\n',
  'package.json': '{"name":"app","version":"1.0.0"}',
  'playwright.config.ts': "export default { testDir: './tests' };\n",
};

test('Gate 4 binds page objects, the seed spec, fixtures.ts, tsconfig.json and package.json', () => {
  for (const [rel, content] of [
    [
      'pages/login.page.ts',
      "import { base } from './base.js';\nexport class LoginPage { x = 1 }\n",
    ],
    ['pages/base.ts', 'export const base = 2;\n'],
    ['tests/seed.spec.ts', '// seed edited after review\n'],
    ['tests/fixtures.ts', 'export const fixture = 2;\n'],
    ['tsconfig.json', '{ "compilerOptions": { "strict": false } }\n'],
    ['package.json', '{"name":"app","version":"1.0.1"}'],
  ]) {
    const dir = repo();
    try {
      writeCompletedRun(dir, {}, CODE_FILES);
      assert.deepEqual(staleGates(dir), [], `${rel}: current before`);
      writeFileSync(join(dir, rel), content);
      assert.deepEqual(staleGates(dir), ['code_reviewed'], rel);
      const g4 = findInvalidations(ctxOf(dir), dir)[0];
      assert.deepEqual(g4.changed_inputs, [rel], rel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an approval records binding version 2 and never binds an environment file', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, {}, CODE_FILES);
    const g4 = ctxOf(dir).review_gates.code_reviewed;
    assert.equal(g4.binding_version, 2);
    assert.ok('pages/login.page.ts' in g4.inputs);
    assert.ok('tests/seed.spec.ts' in g4.inputs);
    assert.ok(!Object.keys(g4.inputs).some((k) => k.includes('.env')));
    writeFileSync(join(dir, 'tests/.env.local'), 'SECRET=changed\n');
    assert.deepEqual(staleGates(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approval recorded under binding version 1 keeps verifying with the v1 inputs', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, {}, CODE_FILES);
    // Re-record Gate 4 exactly as a v1 runner did: no binding_version.
    const ctx = ctxOf(dir);
    const rest = { ...ctx.review_gates.code_reviewed };
    delete rest.binding_version;
    ctx.review_gates.code_reviewed = {
      ...rest,
      input_digest: gateDigest('code_reviewed', ctx, dir, 1),
      inputs: gateInputs('code_reviewed', ctx, dir, 1),
    };
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
    assert.deepEqual(staleGates(dir), []);
    // v1 never bound the seed spec or page objects: still current.
    writeFileSync(join(dir, 'tests/seed.spec.ts'), '// edited\n');
    writeFileSync(join(dir, 'pages/base.ts'), 'export const base = 3;\n');
    assert.deepEqual(staleGates(dir), []);
    // What v1 did bind still counts.
    writeFileSync(join(dir, 'tests/OLD-1.spec.ts'), '// edited\n');
    assert.deepEqual(staleGates(dir), ['code_reviewed']);
    assert.deepEqual(findInvalidations(ctxOf(dir), dir)[0].changed_inputs, [
      'generated_test',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the testDir is read from the Playwright config, and stays inside the repository', () => {
  const dir = repo();
  try {
    const cfg = (t) => writeFileSync(join(dir, 'playwright.config.ts'), t);
    assert.equal(playwrightTestDir(dir), 'tests');
    cfg("export default defineConfig({ testDir: './e2e/' });\n");
    assert.equal(playwrightTestDir(dir), 'tests', 'e2e does not exist yet');
    mkdirSync(join(dir, 'e2e'));
    assert.equal(playwrightTestDir(dir), 'e2e');
    cfg(
      "// testDir: './old',\n/* testDir: './older' */\nexport default { testDir: './e2e' };\n"
    );
    assert.equal(playwrightTestDir(dir), 'e2e', 'comments are ignored');
    cfg('export default { testDir: `${__dirname}/e2e` };\n');
    assert.equal(playwrightTestDir(dir), 'tests', 'not a plain literal');
    cfg("export default defineConfig({ testDir: '../elsewhere' });\n");
    assert.equal(playwrightTestDir(dir), 'tests');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 4 binds a non-default testDir, and a file added there makes it stale', () => {
  const dir = repo();
  try {
    writeCompletedRun(
      dir,
      {},
      {
        ...CODE_FILES,
        'playwright.config.ts': "export default { testDir: './e2e' };\n",
        'e2e/helper.spec.ts': '// a spec in the configured testDir\n',
      }
    );
    assert.ok(
      'e2e/helper.spec.ts' in ctxOf(dir).review_gates.code_reviewed.inputs
    );
    writeFileSync(join(dir, 'e2e/added.spec.ts'), '// added after review\n');
    assert.deepEqual(staleGates(dir), ['code_reviewed']);
    assert.deepEqual(findInvalidations(ctxOf(dir), dir)[0].changed_inputs, [
      'e2e/added.spec.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime state, OS and editor files under the testDir are never bound', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, {}, CODE_FILES);
    for (const [rel, text] of [
      ['tests/.auth/user.json', '{"cookies":[{"name":"session"}]}'],
      ['tests/.DS_Store', 'x'],
      ['tests/Thumbs.db', 'x'],
      ['tests/OLD-1.spec.ts~', 'x'],
    ]) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    assert.deepEqual(staleGates(dir), []);
    assert.ok(
      !gateFiles('code_reviewed', ctxOf(dir), dir).some((f) =>
        /\.auth|DS_Store|Thumbs|~$/.test(f.path)
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed binary baseline makes Gate 4 stale, byte for byte', () => {
  const dir = repo();
  const png = 'tests/OLD-1.spec.ts-snapshots/cart.png';
  try {
    writeCompletedRun(
      dir,
      {},
      { ...CODE_FILES, [png]: Buffer.from([0x89, 0x50, 0xff, 0xfe]) }
    );
    assert.deepEqual(staleGates(dir), []);
    writeFileSync(join(dir, png), Buffer.from([0x89, 0x50, 0xfe, 0xff]));
    assert.deepEqual(findInvalidations(ctxOf(dir), dir)[0].changed_inputs, [
      png,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file Gate 4 keys on its own is bound once, even when a test imports it', () => {
  const dir = repo();
  try {
    writeCompletedRun(
      dir,
      {},
      {
        ...CODE_FILES,
        'tests/OLD-1.spec.ts':
          "import pkg from '../package.json';\n// generated\n",
      }
    );
    const ctx = ctxOf(dir);
    ctx.artifact_paths.generated_test = './tests/OLD-1.spec.ts';
    const paths = gateFiles('code_reviewed', ctx, dir).map((f) => f.path);
    assert.equal(paths.filter((p) => p === 'package.json').length, 1);
    assert.ok(
      !paths.includes('tests/OLD-1.spec.ts'),
      'keyed as generated_test'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approval recorded under a binding version this checkout does not know is not current', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, {}, CODE_FILES);
    const ctx = ctxOf(dir);
    ctx.review_gates.code_reviewed.binding_version = 99;
    const s = requireCurrentGate(ctx, 'code_reviewed', dir);
    assert.equal(s.ok, false);
    assert.match(s.reason, /binding_version 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
