// A genuinely COMPLETED run, for tests that need one.
//
// "Completed" is no longer a label: the runner accepts a run as done only when
// every artifact exists, validates against its schema, and belongs to the run
// (same story id and run id), the execution report is newer than the code it
// ran, the failure analysis is finalized with a bug draft per Red failure, and
// the release report is valid. Fixtures once used `{}` files with
// `status: "completed"` -- which is exactly the false completion the runner now refuses.
// This builds the real thing from the repo's gold examples.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bindingFor } from '../../scripts/lib/approval-binding.js';
import { playwrightIdentity } from '../../scripts/lib/execution-identity.js';

const REPO = process.cwd();
const gold = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

export const GATE = {
  status: true,
  reviewer: 'h',
  reviewed_at: '2026-09-01T00:00:00Z',
};

export function runContext({
  storyId = 'OLD-1',
  runId = 'old-run-1',
  status = 'completed',
  gates = true,
} = {}) {
  const g = gates ? GATE : false;
  return {
    schema_version: '1.0',
    run_id: runId,
    story: { id: storyId, title: 'old', source: 'manual', path: 'story.md' },
    acceptance_criteria: ['a'],
    ambiguities: [],
    risks: [],
    artifact_paths: {
      test_cases: `test-cases/${storyId}.json`,
      planner_brief: `planner-input/${storyId}.planner-brief.md`,
      playwright_spec: `specs/${storyId}.md`,
      generated_test: `tests/${storyId}.spec.ts`,
      execution_results: 'reports/results.json',
      html_report: 'reports/html',
      traces: 'reports/test-results',
      screenshots: 'reports/test-results',
      failure_analysis: 'analysis/failure-analysis.json',
      release_report_md: 'release/release-report.md',
      release_report_json: 'release/release-report.json',
      bug_drafts_dir: 'release/bug-drafts',
    },
    review_gates: {
      requirements_reviewed: g,
      test_scope_reviewed: g,
      specs_reviewed: g,
      code_reviewed: g,
    },
    status,
  };
}

/**
 * Write every artifact of a completed run into `dir`. `overrides` replaces
 * individual artifacts' contents (a string is written verbatim) so a test can
 * break exactly one thing.
 */
export function writeCompletedRun(dir, opts = {}, overrides = {}) {
  const { storyId = 'OLD-1', runId = 'old-run-1' } = opts;
  const ctx = runContext({ ...opts, storyId, runId });
  // The criteria and the one risk the test cases below reference. The
  // ledger has TC-001 passing and TC-002 failing, so the risk is covered and
  // failing.
  ctx.acceptance_criteria = gold(
    'examples/expected/login-success-audited.expected-context.json'
  ).acceptance_criteria;
  ctx.risks = [
    gold('examples/expected/login-success-audited.expected-context.json')
      .risks[0],
  ];
  const own = (doc) => ({ ...doc, story_id: storyId, run_id: runId });

  const tc = validTestCases(storyId, runId);

  const ledger = own(
    gold('examples/expected/mixed-run.expected-execution-ledger.json')
  );
  const t = ledger.totals;
  const analysis = {
    schema_version: '2.0',
    run_id: runId,
    story_id: storyId,
    execution_date: '2026-09-02T00:00:00Z',
    execution_ledger: 'analysis/execution-ledger.json',
    total_tests: t.units,
    passed: t.passed,
    failed: t.failed + t.blocked + t.flaky,
    skipped: t.skipped + t.not_run + t.expected_failure,
    outcome_breakdown: {
      units: t.units,
      passed: t.passed,
      failed: t.failed,
      flaky: t.flaky,
      skipped: t.skipped,
      blocked: t.blocked,
      not_run: t.not_run,
      expected_failure: t.expected_failure,
      source_error_count: t.source_error_count,
    },
    source_errors: [],
    failures: [],
    status: 'finalized',
  };

  const files = {
    'story.md': `# ${storyId}\nThe story.\n`,
    [`test-cases/${storyId}.json`]: JSON.stringify(tc),
    [`planner-input/${storyId}.planner-brief.md`]: '# brief\n',
    [`specs/${storyId}.md`]: '# spec\n',
    [`tests/${storyId}.spec.ts`]: '// generated\n',
    'tests/seed.spec.ts': '// seed: reusable across runs\n',
    'tests/fixtures/README.md': 'reusable\n',
    'test-cases/.gitkeep': '',
    'analysis/execution-ledger.json': JSON.stringify(ledger),
    'analysis/failure-analysis.json': JSON.stringify(analysis),
    'release/release-report.json': JSON.stringify({
      // A 2.0 report: the analysis is 2.x, and its execution_summary is the
      // one derived from this same ledger. Its coverage and failures are this
      // run's (the release rules, scripts/lib/report-checks.js): RISK-001 is
      // covered and failing, the analysis has no failures, so nothing blocks,
      // no bug draft is listed, and the recommendation is a plain fail.
      ...own(gold('examples/expected/mixed-run.expected-release-report.json')),
      coverage_by_risk: [
        {
          risk_id: 'RISK-001',
          covered_by_tcs: ['TC-001', 'TC-002'],
          status: 'covered_failing',
        },
      ],
      uncovered_risks: [],
      uncovered_high_severity_count: 0,
      summary_by_risk_level: {
        high: {
          total: 1,
          covered_passing: 0,
          covered_failing: 1,
          covered_partial: 0,
          accepted_without_test: 0,
          uncovered: 0,
        },
      },
      untested_high_risk_items: [],
      blocking_failures: [],
      non_blocking_failures: [],
      bug_drafts: [],
      release_recommendation: 'fail',
    }),
    'release/release-report.md': '# report\n',
    'context.json': JSON.stringify(ctx, null, 2),
    ...overrides,
  };

  const write = (p, c) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  for (const [p, c] of Object.entries(files)) {
    if (c !== null)
      write(
        p,
        typeof c === 'string' || Buffer.isBuffer(c) ? c : JSON.stringify(c)
      );
  }
  // Every approved gate is BOUND to what now exists, exactly
  // as the runner records it at a human decision. An unbound approval is a
  // legacy one the runner returns to pending. Computed after the overrides are
  // written, so an approved run reflects its final inputs; a test that wants
  // "approved, then changed" makes its change after this returns.
  for (const gate of Object.keys(ctx.review_gates)) {
    const v = ctx.review_gates[gate];
    if (v && typeof v === 'object' && v.status === true) {
      ctx.review_gates[gate] = { ...v, ...bindingFor(gate, ctx, dir) };
    }
  }
  write('context.json', JSON.stringify(ctx, null, 2));

  if (overrides['reports/results.json'] === undefined) {
    write(
      'reports/results.json',
      readFileSync(join(REPO, 'test/fixtures/playwright-all-outcomes.json'))
    );
  }
  // What the execute step records once the report exists: the report is this
  // run's evidence only while it, its config and the Gate 4 approval match.
  if (existsSync(join(dir, 'reports/results.json'))) {
    // The gold ledger's units belong to its Playwright execution, exec-pw-1.
    const identity = {
      ...playwrightIdentity({
        root: dir,
        reportPath: 'reports/results.json',
        configPath: 'playwright.config.ts',
        context: ctx,
        env: {},
        now: '2026-09-02T00:00:00Z',
      }),
      execution_id: 'exec-pw-1',
    };
    ctx.execution_identity = { playwright: identity };
    write('context.json', JSON.stringify(ctx, null, 2));
    // ...and the classify step normalized THAT execution into the ledger.
    if (overrides['analysis/execution-ledger.json'] === undefined) {
      const pw = ledger.source_executions.find(
        (/** @type {any} */ s) => s.runner === 'playwright'
      );
      if (pw) pw.config_identity = identity;
      // The repeat check ran against this run's Gate 4 approval, or not at all.
      if (ledger.repeat_check) {
        if (identity.gate_digest)
          ledger.repeat_check.input_digest = identity.gate_digest;
        else delete ledger.repeat_check;
      }
      write('analysis/execution-ledger.json', JSON.stringify(ledger));
    }
  }
  return ctx;
}

/** Bind one approved gate of a context to what exists under `dir`. */
export function bindGate(ctx, gate, dir) {
  ctx.review_gates[gate] = {
    status: true,
    reviewer: 'h',
    reviewed_at: GATE.reviewed_at,
    ...bindingFor(gate, ctx, dir),
  };
  return ctx;
}

/**
 * Schema-valid, E2E-only test cases owned by the given story and run, each
 * DECIDED (`approved`): per-case decisions are part of the scope Gate 2
 * approves, and `draft` is not valid after it (docs/review-gates.md).
 */
export function validTestCases(storyId, runId) {
  const tc = scopeCases(storyId, runId);
  return {
    ...tc,
    // E2E only: an approved manual/skip case would open the external branch,
    // whose reviews a plain completed E2E run never had.
    test_cases: tc.test_cases.filter(
      (c) => c.automation_decision === 'automate_e2e'
    ),
  };
}

/**
 * Three approved gold cases (TC-001, TC-002, TC-004) for tests that set each
 * case's automation decision and status themselves.
 */
export function scopeCases(storyId, runId) {
  const tc = gold('examples/expected/login-success.expected-test-cases.json');
  return {
    ...tc,
    story_id: storyId,
    run_id: runId,
    test_cases: tc.test_cases
      .filter((c) => c.automation_decision !== 'automate_api')
      .map((c) => ({ ...c, status: 'approved' })),
  };
}
