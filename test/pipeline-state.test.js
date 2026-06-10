// Unit tests for the pure pipeline state machine (IMPROVEMENT-PLAN IP-2.4).
// Table-driven: each case is a context shape -> expected next step. The
// critical property under test is GATE-BLOCK: if a gate is not passed, the
// machine returns the gate, never the step behind it — regardless of how
// many downstream artifacts already exist (CLAUDE.md §3.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextStep,
  gatePassed,
  blockingAmbiguities,
  GATE_KEYS,
} from '../scripts/pipeline-state.js';

// Minimal context factory; overrides patch gates/paths per case.
function ctx({
  gates = {},
  paths = {},
  status = 'draft',
  ambiguities = [],
} = {}) {
  return {
    schema_version: '1.0',
    run_id: 'test-run',
    story: { id: 'STORY-001', title: 't', source: 'manual', path: 'story.md' },
    acceptance_criteria: ['AC'],
    ambiguities,
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
      ...paths,
    },
    review_gates: {
      requirements_reviewed: false,
      test_scope_reviewed: false,
      specs_reviewed: false,
      code_reviewed: false,
      ...gates,
    },
    status,
  };
}

const ALL_PATHS = {
  test_cases: 'test-cases/STORY-001.json',
  planner_brief: 'planner-input/STORY-001.planner-brief.md',
  playwright_spec: 'specs/STORY-001.md',
  generated_test: 'tests/STORY-001.spec.ts',
  execution_results: 'reports/results.json',
  failure_analysis: 'analysis/failure-analysis.json',
  release_report_md: 'release/release-report.md',
  release_report_json: 'release/release-report.json',
};
const ALL_GATES = {
  requirements_reviewed: true,
  test_scope_reviewed: true,
  specs_reviewed: true,
  code_reviewed: true,
};

test('nextStep — sequencing table', () => {
  const cases = [
    ['no context at all', null, {}, 'analyst'],
    ['fresh draft, nothing passed', ctx(), {}, 'gate1'],
    [
      'gate1 passed (boolean), no test cases yet',
      ctx({ gates: { requirements_reviewed: true } }),
      {},
      'test-designer',
    ],
    [
      'gate1 passed (audit object), cases written, gate2 pending',
      ctx({
        gates: { requirements_reviewed: { status: true } },
        paths: { test_cases: ALL_PATHS.test_cases },
      }),
      {},
      'gate2',
    ],
    [
      'GATE-BLOCK: gate2 unpassed blocks even with ALL downstream artifacts',
      ctx({
        gates: {
          requirements_reviewed: true,
          specs_reviewed: true,
          code_reviewed: true,
        },
        paths: ALL_PATHS,
      }),
      {},
      'gate2',
    ],
    [
      'qa_scope_approved consolidates G1+G2 (both false underneath)',
      ctx({
        gates: { qa_scope_approved: true },
        paths: { test_cases: ALL_PATHS.test_cases },
      }),
      {},
      'planner',
    ],
    [
      'gate2 passed, spec missing',
      ctx({
        gates: { requirements_reviewed: true, test_scope_reviewed: true },
        paths: { test_cases: ALL_PATHS.test_cases },
      }),
      {},
      'planner',
    ],
    [
      'spec written, gate3 pending',
      ctx({
        gates: { requirements_reviewed: true, test_scope_reviewed: true },
        paths: {
          test_cases: ALL_PATHS.test_cases,
          playwright_spec: ALL_PATHS.playwright_spec,
        },
      }),
      {},
      'gate3',
    ],
    [
      'API branch: automate_api cases without a collection insert the api step',
      ctx({
        gates: { requirements_reviewed: true, test_scope_reviewed: true },
        paths: {
          test_cases: ALL_PATHS.test_cases,
          playwright_spec: ALL_PATHS.playwright_spec,
        },
      }),
      { hasApiCases: true, apiCollectionExists: false },
      'api',
    ],
    [
      'API branch: collection exists -> proceed to gate3',
      ctx({
        gates: { requirements_reviewed: true, test_scope_reviewed: true },
        paths: {
          test_cases: ALL_PATHS.test_cases,
          playwright_spec: ALL_PATHS.playwright_spec,
        },
      }),
      { hasApiCases: true, apiCollectionExists: true },
      'gate3',
    ],
    [
      'gate3 passed, no generated test',
      ctx({
        gates: {
          requirements_reviewed: true,
          test_scope_reviewed: true,
          specs_reviewed: { status: true, reviewer: 'bob' },
        },
        paths: {
          test_cases: ALL_PATHS.test_cases,
          playwright_spec: ALL_PATHS.playwright_spec,
        },
      }),
      {},
      'generator',
    ],
    [
      'GATE-BLOCK: gate4 unpassed blocks execute even with results path filled',
      ctx({
        gates: {
          requirements_reviewed: true,
          test_scope_reviewed: true,
          specs_reviewed: true,
        },
        paths: { ...ALL_PATHS },
      }),
      {},
      'gate4',
    ],
    [
      'gate4 passed, nothing executed yet',
      ctx({
        gates: ALL_GATES,
        paths: {
          test_cases: ALL_PATHS.test_cases,
          playwright_spec: ALL_PATHS.playwright_spec,
          generated_test: ALL_PATHS.generated_test,
        },
      }),
      {},
      'execute',
    ],
    [
      'results path prefilled but file does not exist -> still execute',
      ctx({ gates: ALL_GATES, paths: ALL_PATHS }),
      { executionResultsExist: false },
      'execute',
    ],
    [
      'executed, no failure analysis yet',
      ctx({
        gates: ALL_GATES,
        paths: { ...ALL_PATHS, failure_analysis: '', release_report_json: '' },
      }),
      { executionResultsExist: true },
      'classify',
    ],
    [
      'classified, no release report yet',
      ctx({
        gates: ALL_GATES,
        paths: { ...ALL_PATHS, release_report_json: '' },
      }),
      { executionResultsExist: true, failureAnalysisExists: true },
      'report',
    ],
    [
      'everything produced -> done',
      ctx({ gates: ALL_GATES, paths: ALL_PATHS, status: 'completed' }),
      {
        executionResultsExist: true,
        failureAnalysisExists: true,
        releaseReportExists: true,
      },
      'done',
    ],
  ];

  for (const [name, context, hints, expected] of cases) {
    assert.equal(nextStep(context, hints), expected, `case: ${name}`);
  }
});

test('gatePassed — the binding read rule (docs/review-gates.md)', () => {
  assert.equal(gatePassed(true), true);
  assert.equal(gatePassed({ status: true, reviewer: 'a' }), true);
  assert.equal(gatePassed(false), false);
  assert.equal(gatePassed({ status: false }), false);
  assert.equal(gatePassed(undefined), false);
  assert.equal(gatePassed(null), false);
});

test('blockingAmbiguities — only blocking ones halt', () => {
  assert.deepEqual(blockingAmbiguities(null), []);
  assert.deepEqual(blockingAmbiguities(ctx()), []);
  assert.deepEqual(
    blockingAmbiguities(
      ctx({ ambiguities: [{ description: 'minor', blocking: false }] })
    ),
    []
  );
  assert.deepEqual(
    blockingAmbiguities(
      ctx({
        ambiguities: [
          { description: 'minor', blocking: false },
          { description: 'major unknown', blocking: true },
        ],
      })
    ),
    ['major unknown']
  );
});

test('GATE_KEYS maps the four runner gates to review_gates keys', () => {
  assert.deepEqual(GATE_KEYS, {
    gate1: 'requirements_reviewed',
    gate2: 'test_scope_reviewed',
    gate3: 'specs_reviewed',
    gate4: 'code_reviewed',
  });
});
