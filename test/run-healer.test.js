// Healer candidate processing (task group 6.3, review finding S3).
//
// The real run-healer.js runs in a throwaway project. The Playwright CLI is
// replaced by test/fixtures/fake-playwright-cli.js (QAIZEN_PLAYWRIGHT_CLI) so
// every orchestration path is tested without a browser; the last test runs
// the real Playwright against the offline demo app when a browser is
// installed.
//
// Acceptance (IMPLEMENTATION_PLAN 6.3): a real supplied candidate produces a
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
import { buildLedger } from '../scripts/lib/build-ledger.js';
import { approvedScopeDigest } from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

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
    rmSync(dir, { recursive: true, force: true });
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
    for (const args of r.calls) {
      assert.equal(args[0], 'test');
      assert.equal(args[1], TEST_REL);
      assert.deepEqual(
        args.slice(args.indexOf('--retries'), args.indexOf('--retries') + 2),
        ['--retries', '0']
      );
      assert.deepEqual(
        args.slice(
          args.indexOf('--repeat-each'),
          args.indexOf('--repeat-each') + 2
        ),
        ['--repeat-each', '1']
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
    assert.equal(rec.rerun.tests_executed, 1);
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
      rmSync(check, { recursive: true, force: true });
    }
    liveUnchanged(dir);
    noWorkspaceLeft(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      /unchanged original did not fail in the isolated copy \(passed/
    );
    assert.match(r.out, /no attempt was used/);
    assert.equal(r.calls.length, 1, 'only the baseline ran');
    assert.deepEqual(records(dir), []);
    noWorkspaceLeft(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
});
