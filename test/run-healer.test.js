// Healer candidate processing.
//
// The real run-healer.js runs in a throwaway project. The Playwright CLI is
// replaced by test/fixtures/fake-playwright-cli.js (QAIZEN_PLAYWRIGHT_CLI) so
// every orchestration path is tested without a browser; the last test runs
// the real Playwright against the offline demo app when a browser is
// installed.
//
// Acceptance: a real supplied candidate produces a
// usable patch and evidence; every rejected/failed candidate leaves live tests
// unchanged; no result is labelled a human-approved fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { bindGate, runContext, validTestCases } from './helpers/valid-run.js';
import { removeTempDir } from './helpers/cleanup.js';
import { buildLedger } from '../scripts/lib/build-ledger.js';
import { approvedScopeDigest } from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { keepHealerAttempts } from '../scripts/lib/healer-candidate.js';
import { copyRuntimeConfig } from './helpers/runtime-config.js';

const REPO = process.cwd();
const STORY = 'HEAL-1';
const RUN = 'run-heal-1';
const TEST_REL = `tests/${STORY}.spec.ts`;
const TITLE = 'logs in and sees the products [TC-001]';
const FAKE_CLI = join(REPO, 'test', 'fixtures', 'fake-playwright-cli.js');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const gold = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

const ORIGINAL = `import { test, expect } from '@playwright/test';

// PW-001 SPEC-001
test('${TITLE}', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-test="username"]').fill('demo');
  await page.locator('[data-test="password"]').fill('demo123');
  await page.locator('#missing-button').click();
  await expect(page.locator('[data-test="title"]')).toHaveText('Products');
});
`;
const FIXED = ORIGINAL.replace(
  "page.locator('#missing-button')",
  'page.locator(\'[data-test="login-button"]\')'
);

const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  retries: 0,
  workers: 1,
  reporter: [['json', { outputFile: 'reports/results.json' }]],
  use: { baseURL: process.env.BASE_URL, actionTimeout: 2000 },
});
`;

// ------------------------------------------------------------ fixture

const UNIT = {
  unit_id: `pw:default:${STORY}.spec.ts > ${TITLE}`,
  execution_id: 'exec-1',
  identity: {
    kind: 'playwright',
    test_title: `${STORY}.spec.ts > ${TITLE}`,
    file: `${STORY}.spec.ts`,
    repeat_index: 0,
  },
  domain_links: {
    test_case_id: 'TC-001',
    playwright_test_id: 'PW-001',
    unresolved_reason: null,
  },
  outcome: 'failed',
  attempts: [
    {
      status: 'failed',
      duration_ms: 2100,
      error_message: 'locator.click: Timeout 2000ms exceeded.',
    },
  ],
};

function failureFor(unit, overrides = {}) {
  return {
    failure_id: 'FAIL-001',
    unit_id: unit.unit_id,
    execution_outcome: 'failed',
    runner_identity: unit.identity,
    test_case_id: 'TC-001',
    playwright_test_id: 'PW-001',
    source: 'playwright',
    classification: 'locator_or_selector',
    severity: 'green',
    classification_reason: 'a locator matched nothing during an action',
    error_message: 'locator.click: Timeout 2000ms exceeded.',
    evidence_paths: ['analysis/execution-ledger.json'],
    ...overrides,
  };
}

/** A complete, gate-current run whose one Green failure is FAIL-001. */
function project({ original = ORIGINAL, failure = {} } = {}) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-heal-'));
  for (const d of ['scripts', 'schemas'])
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  copyRuntimeConfig(dir, REPO);
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'test-cases'));
  mkdirSync(join(dir, 'analysis'));
  mkdirSync(join(dir, 'candidates'));
  writeFileSync(join(dir, 'playwright.config.ts'), CONFIG);
  writeFileSync(join(dir, TEST_REL), original);

  const cases = validTestCases(STORY, RUN);
  for (const tc of cases.test_cases) delete tc.external_ids;
  writeFileSync(
    join(dir, 'test-cases', `${STORY}.json`),
    JSON.stringify(cases, null, 2)
  );

  const { ledger } = buildLedger({
    runId: RUN,
    storyId: STORY,
    generatedAt: '2026-09-29T10:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'exec-1',
        runner: 'playwright',
        started_at: '2026-09-29T09:59:00.000Z',
        completed_at: '2026-09-29T10:00:00.000Z',
        command_identity: 'npx playwright test',
        config_identity: 'playwright.config.ts',
        process_status: 'completed',
        exit_code: 1,
        report_reference: 'reports/results.json',
        report_digest: 'c'.repeat(64),
        source_errors: [],
      },
    ],
    units: [UNIT],
    approvedCaseIds: cases.test_cases.map((c) => c.test_case_id),
    approvedScopeDigest: approvedScopeDigest(cases),
  });
  writeFileSync(
    join(dir, 'analysis', 'execution-ledger.json'),
    JSON.stringify(ledger, null, 2)
  );

  const base = gold(
    'examples/expected/classification-evidence.expected-failure-analysis.json'
  );
  const analysis = {
    ...base,
    story_id: STORY,
    run_id: RUN,
    status: 'finalized',
    failures: [failureFor(ledger.units[0], failure)],
  };
  const valid = validateValue(
    analysis,
    join(REPO, 'schemas/failure-analysis.schema.json')
  );
  assert.ok(
    valid.ok,
    `fixture analysis must be valid: ${JSON.stringify(valid.errors)}`
  );
  writeFileSync(
    join(dir, 'analysis', 'failure-analysis.json'),
    JSON.stringify(analysis, null, 2)
  );

  const ctx = runContext({ storyId: STORY, runId: RUN, status: 'draft' });
  ctx.artifact_paths.generated_test = TEST_REL;
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify(bindGate(ctx, 'code_reviewed', dir), null, 2)
  );
  return dir;
}

function heal(dir, args, env = {}) {
  const log = join(dir, 'cli-calls.jsonl');
  const r = spawnSync(execPath, [join('scripts', 'run-healer.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      QAIZEN_PLAYWRIGHT_CLI: FAKE_CLI,
      FAKE_CLI_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), calls };
}

function candidate(dir, name, text) {
  const p = `candidates/${name}.spec.ts`;
  writeFileSync(join(dir, p), text);
  return p;
}

const records = (dir) => {
  const d = join(dir, 'analysis', 'healer-validation');
  return existsSync(d)
    ? readdirSync(d)
        .filter((n) => n.endsWith('.json'))
        .sort()
    : [];
};
const record = (dir, n) =>
  JSON.parse(
    readFileSync(
      join(dir, 'analysis', 'healer-validation', `FAIL-001.attempt-${n}.json`),
      'utf8'
    )
  );
const liveUnchanged = (dir) =>
  assert.equal(sha(readFileSync(join(dir, TEST_REL), 'utf8')), sha(ORIGINAL));
const noWorkspaceLeft = (dir) =>
  assert.deepEqual(
    existsSync(join(dir, '.healer-workspace'))
      ? readdirSync(join(dir, '.healer-workspace'))
      : [],
    []
  );

// ------------------------------------------------------------ tests

test('without --apply only the static check runs; nothing is written or executed', () => {
  const dir = project();
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'fixed', FIXED),
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /Static check: ELIGIBLE — eligible under static checks; human review still required/
    );
    assert.match(r.out, /Static eligibility only/);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(records(dir), []);
    assert.equal(existsSync(join(dir, 'release')), false);
    liveUnchanged(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('a validated candidate yields a patch that reproduces it, plus evidence; the live test is untouched', () => {
  const dir = project();
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'fixed', FIXED),
      '--apply',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /VALIDATED \(attempt 1 of 3\)/);
    assert.match(r.out, /Not applied, not committed/);

    // Baseline then candidate: the same single test, pinned options.
    assert.equal(r.calls.length, 2);
    // The original runs 3 times, the candidate 5.
    assert.deepEqual(
      r.calls.map((args) => args[args.indexOf('--repeat-each') + 1]),
      ['3', '5']
    );
    for (const args of r.calls) {
      assert.equal(args[0], 'test');
      assert.equal(args[1], TEST_REL);
      assert.deepEqual(
        args.slice(args.indexOf('--retries'), args.indexOf('--retries') + 2),
        ['--retries', '0']
      );
      assert.ok(
        !args.some((a) => /update-snapshots|^-u$/.test(a)),
        'never updates snapshots'
      );
    }

    const rec = record(dir, 1);
    assert.equal(rec.outcome, 'validated');
    assert.equal(rec.human_review, 'required');
    assert.equal(rec.baseline.status, 'failed');
    assert.equal(rec.rerun.status, 'passed');
    assert.equal(rec.rerun.tests_executed, 5);
    assert.deepEqual(
      [rec.baseline.runs, rec.baseline.failed, rec.baseline.failure_locations],
      [3, 3, [`${TEST_REL}:8:5`]]
    );
    assert.deepEqual([rec.rerun.runs, rec.rerun.passed], [5, 5]);
    assert.match(rec.reason, /failed 3 of 3 runs at .*:8:5, and passed 5 of 5/);
    assert.deepEqual(rec.static_check.repairs, [
      { line: 8, from: '#missing-button', to: '[data-test="login-button"]' },
    ]);
    assert.ok(
      validateValue(rec, join(REPO, 'schemas/healer-validation.schema.json')).ok
    );
    assert.doesNotMatch(
      readFileSync(
        join(dir, 'analysis', 'healer-validation', 'FAIL-001.attempt-1.md'),
        'utf8'
      ),
      /approved/i
    );

    // The patch applies to a copy of the original and reproduces the candidate.
    const patch = readFileSync(join(dir, rec.patch.path), 'utf8');
    assert.equal(sha(patch), rec.patch.sha256);
    assert.match(patch, new RegExp(`^--- a/${TEST_REL}$`, 'm'));
    const check = mkdtempSync(join(REPO, '.tmp-runner-heal-apply-'));
    try {
      mkdirSync(join(check, 'tests'));
      writeFileSync(join(check, TEST_REL), ORIGINAL);
      const a = spawnSync(
        'git',
        ['-c', 'core.autocrlf=false', 'apply', join(dir, rec.patch.path)],
        {
          cwd: check,
          encoding: 'utf8',
          // Treat `check` as a plain directory, not part of the enclosing repo.
          env: { ...process.env, GIT_CEILING_DIRECTORIES: REPO },
        }
      );
      assert.equal(a.status, 0, a.stderr);
      assert.equal(readFileSync(join(check, TEST_REL), 'utf8'), FIXED);
    } finally {
      removeTempDir(check);
    }
    liveUnchanged(dir);
    noWorkspaceLeft(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('a statically rejected candidate is recorded without running anything', () => {
  const dir = project();
  try {
    const bad = FIXED.replace(
      "toHaveText('Products')",
      "toHaveText('Anything')"
    );
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'bad', bad),
      '--apply',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, []);
    const rec = record(dir, 1);
    assert.equal(rec.outcome, 'rejected_static');
    assert.match(rec.reason, /changes an assertion/);
    assert.equal(rec.patch, null);
    assert.equal(existsSync(join(dir, 'release', 'healer-patches')), false);
    liveUnchanged(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('a candidate that still fails, skips, or runs no single test is validation_failed', () => {
  // One project per case: four submissions in one project would hit the cap.
  const cases = [
    [
      'still',
      ORIGINAL.replace("'#missing-button'", "'#missing-button-v2'"),
      /failed/,
    ],
    [
      'skip',
      FIXED.replace('// PW-001 SPEC-001', '// PW-001 SPEC-001 FAKE_SKIP'),
      /skipped/,
    ],
    [
      'zero',
      FIXED.replace('// PW-001 SPEC-001', '// PW-001 SPEC-001 FAKE_ZERO'),
      /no_single_test/,
    ],
    [
      'extra',
      FIXED.replace('// PW-001 SPEC-001', '// PW-001 SPEC-001 FAKE_TWO'),
      /no_single_test/,
    ],
  ];
  for (const [name, text, why] of cases) {
    const dir = project();
    try {
      const r = heal(dir, [
        '--failure',
        'FAIL-001',
        '--candidate',
        candidate(dir, name, text),
        '--apply',
      ]);
      assert.equal(r.code, 1, r.out);
      const rec = record(dir, 1);
      assert.equal(rec.outcome, 'validation_failed', name);
      assert.match(rec.reason, why);
      assert.equal(rec.patch, null);
      assert.equal(existsSync(join(dir, 'release', 'healer-patches')), false);
      liveUnchanged(dir);
      noWorkspaceLeft(dir);
    } finally {
      removeTempDir(dir);
    }
  }
});

test('a baseline that no longer fails validates nothing and uses no attempt', () => {
  const passing = ORIGINAL.replace("'#missing-button'", "'#gone-button'");
  const dir = project({ original: passing });
  try {
    const cand = passing.replace("'#gone-button'", "'#login'");
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'c', cand),
      '--apply',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /unchanged original did not fail 3 of 3 times at the same place in the isolated copy \(passed, failed 0 of 3/
    );
    assert.match(r.out, /no attempt was used/);
    assert.equal(r.calls.length, 1, 'only the baseline ran');
    assert.deepEqual(records(dir), []);
    noWorkspaceLeft(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('refused before anything runs: changed original, wrong failure, Yellow, API, or the live file as candidate', () => {
  const variants = [
    [
      (dir) =>
        writeFileSync(
          join(dir, TEST_REL),
          ORIGINAL + '\n// edited after review\n'
        ),
      ['FAIL-001'],
      /code_reviewed is stale/,
      1,
    ],
    [
      () => {},
      ['FAIL-009'],
      /FAIL-009 is not a failure of the current analysis/,
      1,
    ],
  ];
  for (const [arrange, [failureId], why, code] of variants) {
    const dir = project();
    try {
      arrange(dir);
      const r = heal(dir, [
        '--failure',
        failureId,
        '--candidate',
        candidate(dir, 'fixed', FIXED),
        '--apply',
      ]);
      assert.equal(r.code, code, r.out);
      assert.match(r.out, why);
      assert.deepEqual(r.calls, []);
      assert.deepEqual(records(dir), []);
    } finally {
      removeTempDir(dir);
    }
  }
  for (const [failure, why] of [
    [
      { severity: 'yellow', classification: 'ui_structural_change' },
      /not Green/,
    ],
    [
      { source: 'newman', request_id: 'REQ-001' },
      /never touches API\/Newman tests/,
    ],
  ]) {
    const dir = project({ failure });
    try {
      const r = heal(dir, [
        '--failure',
        'FAIL-001',
        '--candidate',
        candidate(dir, 'fixed', FIXED),
        '--apply',
      ]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, why);
      assert.deepEqual(r.calls, []);
    } finally {
      removeTempDir(dir);
    }
  }
  const dir = project();
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      TEST_REL,
      '--apply',
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /The candidate is the live test file/);
    liveUnchanged(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('three submissions per test, persisted; an identical resubmission reuses its outcome', () => {
  const dir = project();
  try {
    const bad = (n) =>
      FIXED.replace("toHaveText('Products')", `toHaveText('Other ${n}')`);
    for (let n = 1; n <= 3; n++) {
      const r = heal(dir, [
        '--failure',
        'FAIL-001',
        '--candidate',
        candidate(dir, `bad${n}`, bad(n)),
        '--apply',
      ]);
      assert.equal(r.code, 1, r.out);
      assert.equal(record(dir, n).attempt, n);
    }
    // A fourth different candidate — even a good one — is refused.
    const fourth = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'fixed', FIXED),
      '--apply',
    ]);
    assert.equal(fourth.code, 1, fourth.out);
    assert.match(
      fourth.out,
      /All 3 submissions for this test in this run are used/
    );
    assert.deepEqual(fourth.calls, []);
    assert.ok(
      existsSync(
        join(dir, 'analysis', 'healer-validation', 'FAIL-001.exhausted.md')
      )
    );
    assert.equal(
      existsSync(
        join(dir, 'analysis', 'healer-validation', 'FAIL-001.attempt-4.json')
      ),
      false
    );

    // Resubmitting candidate #2 reuses its record instead of a new attempt.
    const again = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      'candidates/bad2.spec.ts',
      '--apply',
    ]);
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /already submitted \(attempt 2\): rejected_static/);
    assert.deepEqual(records(dir), [
      'FAIL-001.attempt-1.json',
      'FAIL-001.attempt-2.json',
      'FAIL-001.attempt-3.json',
    ]);
    liveUnchanged(dir);
  } finally {
    removeTempDir(dir);
  }
});

const contextOf = (dir) =>
  JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const writeContextOf = (dir, ctx) =>
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
const submit = (dir, name, text) =>
  heal(dir, [
    '--failure',
    'FAIL-001',
    '--candidate',
    candidate(dir, name, text),
    '--apply',
  ]);
const badCandidate = (n) =>
  FIXED.replace("toHaveText('Products')", `toHaveText('Other ${n}')`);

test('each submission is added to context.json healer_attempts[] with its record digest', () => {
  const dir = project();
  try {
    const r = submit(dir, 'bad1', badCandidate(1));
    assert.equal(r.code, 1, r.out);
    const ctx = contextOf(dir);
    const valid = validateValue(ctx, join(REPO, 'schemas/context.schema.json'));
    assert.ok(valid.ok, JSON.stringify(valid.errors));
    assert.equal(ctx.healer_attempts.length, 1);
    const [entry] = ctx.healer_attempts;
    const path = 'analysis/healer-validation/FAIL-001.attempt-1.json';
    assert.deepEqual(
      {
        run_id: entry.run_id,
        failure_id: entry.failure_id,
        unit_id: entry.unit_id,
        original_sha256: entry.original_sha256,
        candidate_sha256: entry.candidate_sha256,
        attempt: entry.attempt,
        outcome: entry.outcome,
        record: entry.record,
      },
      {
        run_id: RUN,
        failure_id: 'FAIL-001',
        unit_id: UNIT.unit_id,
        original_sha256: sha(ORIGINAL),
        candidate_sha256: sha(badCandidate(1)),
        attempt: 1,
        outcome: 'rejected_static',
        record: { path, sha256: sha(readFileSync(join(dir, path))) },
      }
    );
    // The gate it ran under stays current: the attempts are not reviewed input.
    const again = submit(dir, 'bad2', badCandidate(2));
    assert.doesNotMatch(again.out, /Gate 4/, again.out);
    assert.equal(contextOf(dir).healer_attempts.length, 2);
  } finally {
    removeTempDir(dir);
  }
});

test('deleting the record files gives no attempt back', () => {
  const dir = project();
  try {
    for (let n = 1; n <= 3; n++)
      assert.equal(submit(dir, `bad${n}`, badCandidate(n)).code, 1);
    rmSync(join(dir, 'analysis', 'healer-validation'), {
      recursive: true,
      force: true,
    });

    const fourth = submit(dir, 'fixed', FIXED);
    assert.equal(fourth.code, 1, fourth.out);
    assert.match(
      fourth.out,
      /All 3 submissions for this test in this run are used/
    );
    assert.match(fourth.out, /record of attempt 1 .* is missing/);
    assert.deepEqual(fourth.calls, []);

    // An identical resubmission still reuses its outcome from context.json.
    const again = submit(dir, 'bad2', badCandidate(2));
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /already submitted \(attempt 2\): rejected_static/);
    liveUnchanged(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('a record file counts without its context entry, and an edited one does not change the outcome', () => {
  const dir = project();
  try {
    for (let n = 1; n <= 2; n++)
      assert.equal(submit(dir, `bad${n}`, badCandidate(n)).code, 1);
    // Attempt 1 leaves context.json (an edited context, or a record from
    // before the context kept attempts); its record file still counts.
    const ctx = contextOf(dir);
    ctx.healer_attempts = ctx.healer_attempts.filter((e) => e.attempt !== 1);
    writeContextOf(dir, ctx);
    // Attempt 2's record is edited to claim it validated.
    const p2 = join(
      dir,
      'analysis',
      'healer-validation',
      'FAIL-001.attempt-2.json'
    );
    writeFileSync(
      p2,
      JSON.stringify({ ...record(dir, 2), outcome: 'validated' }, null, 2)
    );

    const again = submit(dir, 'bad2', badCandidate(2));
    assert.equal(again.code, 1, again.out);
    // The record-only attempt is added to context.json before anything else.
    assert.match(again.out, /Added 1 attempt\(s\) found only as record files/);
    assert.deepEqual(
      contextOf(dir)
        .healer_attempts.map((e) => e.attempt)
        .sort(),
      [1, 2]
    );
    assert.match(again.out, /attempt-2\.json changed after attempt 2/);
    assert.match(again.out, /already submitted \(attempt 2\): rejected_static/);

    const third = submit(dir, 'bad3', badCandidate(3));
    assert.equal(third.code, 1, third.out);
    assert.equal(record(dir, 3).attempt, 3);
    // Once added, deleting the records gives nothing back.
    rmSync(join(dir, 'analysis', 'healer-validation'), {
      recursive: true,
      force: true,
    });
    const fourth = submit(dir, 'fixed', FIXED);
    assert.match(
      fourth.out,
      /All 3 submissions for this test in this run are used/
    );
    assert.deepEqual(fourth.calls, []);
  } finally {
    removeTempDir(dir);
  }
});

test('--apply refuses before anything runs when context.json does not validate', () => {
  const dir = project();
  try {
    writeContextOf(dir, { ...contextOf(dir), not_a_context_field: true });
    const r = submit(dir, 'fixed', FIXED);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Refusing: the Healer records each attempt/);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(records(dir), []);
  } finally {
    removeTempDir(dir);
  }
});

test('a validated outcome is reused only while its record and patch back it', () => {
  const dir = project();
  try {
    assert.equal(submit(dir, 'fixed', FIXED).code, 0);
    const resubmit = () =>
      heal(dir, [
        '--failure',
        'FAIL-001',
        '--candidate',
        'candidates/fixed.spec.ts',
        '--apply',
      ]);
    assert.equal(resubmit().code, 0);

    const patch = join(dir, record(dir, 1).patch.path);
    writeFileSync(patch, readFileSync(patch, 'utf8') + '\n');
    let r = resubmit();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /patch .* changed after attempt 1/);

    rmSync(join(dir, 'release'), { recursive: true, force: true });
    r = resubmit();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /patch of attempt 1 .* is missing/);

    rmSync(join(dir, 'analysis', 'healer-validation'), {
      recursive: true,
      force: true,
    });
    const callsBefore = r.calls.length;
    r = resubmit();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /record of attempt 1 .* is missing/);
    assert.equal(r.calls.length, callsBefore, 'nothing re-ran');
  } finally {
    removeTempDir(dir);
  }
});

test('a context entry that disagrees with its intact record is reported and not reused as validated', () => {
  const dir = project();
  try {
    assert.equal(submit(dir, 'bad1', badCandidate(1)).code, 1);
    const ctx = contextOf(dir);
    ctx.healer_attempts[0].outcome = 'validated';
    writeContextOf(dir, ctx);
    const r = submit(dir, 'bad1', badCandidate(1));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /context\.json disagrees with .*attempt-1\.json/);
    assert.match(r.out, /Not reported as validated/);
  } finally {
    removeTempDir(dir);
  }
});

test('a record whose number does not match its file name is reported, and no number past the cap is used', () => {
  const dir = project();
  try {
    assert.equal(submit(dir, 'bad1', badCandidate(1)).code, 1);
    const ctx = contextOf(dir);
    delete ctx.healer_attempts;
    writeContextOf(dir, ctx);
    const p1 = join(
      dir,
      'analysis',
      'healer-validation',
      'FAIL-001.attempt-1.json'
    );
    writeFileSync(p1, JSON.stringify({ ...record(dir, 1), attempt: 3 }));
    const r = submit(dir, 'fixed', FIXED);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /attempt-1\.json says it is attempt 3/);
    assert.match(r.out, /No attempt number up to 3 is left/);
    assert.deepEqual(r.calls, []);
    assert.ok(
      existsSync(
        join(dir, 'analysis', 'healer-validation', 'FAIL-001.exhausted.md')
      )
    );
  } finally {
    removeTempDir(dir);
  }
});

test('the runner keeps healer attempts written while it held an older copy', () => {
  const entry = (attempt, run_id = RUN) => ({
    run_id,
    unit_id: UNIT.unit_id,
    original_sha256: sha(ORIGINAL),
    attempt,
  });
  const held = { run_id: RUN, healer_attempts: [entry(1)] };
  keepHealerAttempts(held, {
    run_id: RUN,
    healer_attempts: [entry(1), entry(2)],
  });
  assert.deepEqual(
    held.healer_attempts.map((e) => e.attempt),
    [1, 2]
  );
  const other = { run_id: 'a-new-run' };
  keepHealerAttempts(other, { run_id: RUN, healer_attempts: [entry(1)] });
  assert.equal(other.healer_attempts, undefined);
  const none = { run_id: RUN };
  keepHealerAttempts(none, null);
  assert.equal(none.healer_attempts, undefined);
});

test('attempts recorded for another run or another original do not count', () => {
  const dir = project();
  try {
    const ctx = contextOf(dir);
    const other = {
      failure_id: 'FAIL-001',
      unit_id: UNIT.unit_id,
      candidate_sha256: 'a'.repeat(64),
      outcome: 'rejected_static',
      reason: 'from elsewhere',
      record: {
        path: 'analysis/healer-validation/FAIL-001.attempt-1.json',
        sha256: 'b'.repeat(64),
      },
      recorded_at: '2026-09-29T10:00:00.000Z',
    };
    ctx.healer_attempts = [1, 2, 3].flatMap((attempt) => [
      {
        ...other,
        attempt,
        run_id: 'an-earlier-run',
        original_sha256: sha(ORIGINAL),
      },
      { ...other, attempt, run_id: RUN, original_sha256: 'c'.repeat(64) },
    ]);
    writeContextOf(dir, ctx);
    const r = submit(dir, 'fixed', FIXED);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /VALIDATED \(attempt 1 of 3\)/);
  } finally {
    removeTempDir(dir);
  }
});

test('triage points Green failures at the candidate command and claims no scaffolding', () => {
  const dir = project();
  try {
    const r = heal(dir, []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /--failure FAIL-001 --candidate <file> --apply/);
    assert.doesNotMatch(r.out, /scaffolding/i);
  } finally {
    removeTempDir(dir);
  }
});

// ------------------------------------------------------------ real browser

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

test('real Playwright: a broken locator is healed against the demo app', async (t) => {
  if (!(await browserInstalled())) {
    t.skip(
      'no Playwright browser installed (CI quality job); run locally for the real acceptance'
    );
    return;
  }
  const server = spawn(execPath, [
    join(REPO, 'examples', 'demo-run', 'serve.js'),
  ]);
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => {
      const m = String(b).match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on('error', reject);
  });
  const dir = project();
  try {
    const env = {
      QAIZEN_PLAYWRIGHT_CLI: '',
      BASE_URL: `http://127.0.0.1:${port}`,
    };
    const r = heal(
      dir,
      [
        '--failure',
        'FAIL-001',
        '--candidate',
        candidate(dir, 'fixed', FIXED),
        '--apply',
      ],
      env
    );
    assert.equal(r.code, 0, r.out);
    const rec = record(dir, 1);
    assert.equal(rec.outcome, 'validated');
    assert.equal(rec.baseline.status, 'failed');
    assert.equal(rec.rerun.status, 'passed');
    assert.ok(existsSync(join(dir, rec.patch.path)));
    liveUnchanged(dir);
    noWorkspaceLeft(dir);
  } finally {
    server.kill();
    removeTempDir(dir);
  }
});

/** The original with a marker comment, and its locator-fixed candidate. */
const marked = (marker) => {
  const original = ORIGINAL.replace(
    '// PW-001 SPEC-001',
    `// PW-001 SPEC-001\n// ${marker}`
  );
  return {
    original,
    fixed: original.replace(
      "page.locator('#missing-button')",
      'page.locator(\'[data-test="login-button"]\')'
    ),
  };
};

test('a flaky original "fixed" by a locator change is refused: it does not fail 3 of 3 times', () => {
  const { original, fixed } = marked('FAKE_FLAKY');
  const dir = project({ original });
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'c', fixed),
      '--apply',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /did not fail 3 of 3 times at the same place in the isolated copy \(flaky, failed 2 of 3/
    );
    assert.match(r.out, /is not a broken locator/);
    assert.match(r.out, /no attempt was used/);
    assert.equal(r.calls.length, 1, 'only the baseline ran');
    assert.deepEqual(records(dir), []);
    noWorkspaceLeft(dir);
  } finally {
    removeTempDir(dir);
  }
});

test('an original that fails in different places is refused', () => {
  const { original, fixed } = marked('FAKE_ELSEWHERE');
  const dir = project({ original });
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'c', fixed),
      '--apply',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /it failed in 2 different places/);
    assert.deepEqual(records(dir), []);
  } finally {
    removeTempDir(dir);
  }
});

test('a candidate that passes 4 of 5 runs is not validated', () => {
  const { original, fixed } = marked('FAKE_SOMETIMES');
  const dir = project({ original });
  try {
    const r = heal(dir, [
      '--failure',
      'FAIL-001',
      '--candidate',
      candidate(dir, 'c', fixed),
      '--apply',
    ]);
    assert.equal(r.code, 1, r.out);
    const rec = record(dir, 1);
    assert.equal(rec.outcome, 'validation_failed');
    assert.match(rec.reason, /flaky with the candidate, passing 4 of 5 runs/);
    assert.deepEqual([rec.baseline.failed, rec.rerun.passed], [3, 4]);
    assert.equal(rec.patch, null);
  } finally {
    removeTempDir(dir);
  }
});
