// A genuinely COMPLETED run, for tests that need one (task groups 4.1-4.2).
//
// "Completed" is no longer a label: the runner accepts a run as done only when
// every artifact exists, validates against its schema, and belongs to the run
// (same story id and run id), the execution report is newer than the code it
// ran, the failure analysis is finalized with a bug draft per Red failure, and
// the release report is valid. The first 4.1 fixtures used `{}` files with
// `status: "completed"` -- which is exactly the false completion 4.2 removes
// (finding I6). This builds the real thing from the repo's gold examples.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bindingFor } from '../../scripts/lib/approval-binding.js';

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
      traces: 'reports/traces',
      screenshots: 'reports/screenshots',
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
    'release/release-report.json': JSON.stringify(
      own(
        gold('examples/expected/enhanced-report.expected-release-report.json')
      )
    ),
    'release/release-report.md': '# report\n',
    'context.json': JSON.stringify(ctx, null, 2),
    ...overrides,
  };

  const write = (p, c) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  for (const [p, c] of Object.entries(files)) {
    if (c !== null) write(p, typeof c === 'string' ? c : JSON.stringify(c));
  }
  // Every approved gate is BOUND to what now exists (task group 4.3), exactly
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

  // Written LAST so it is newer than the generated test it ran.
  if (overrides['reports/results.json'] === undefined) {
    write(
      'reports/results.json',
      readFileSync(join(REPO, 'test/fixtures/playwright-all-outcomes.json'))
    );
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
