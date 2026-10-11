// @ts-check
// The offline demo's replayed stages (scripts/demo-pipeline.js).
//
// The demo drives the REAL runner inside an isolated workspace. Before each
// agent step it replays that agent's output from examples/demo-run/, so no
// artifact is generated from text (CLAUDE.md §3.8). Execution and the
// rule-based pre-classifier stay real. These functions only write into the
// demo workspace, and each artifact they write is validated first.
//
// Nothing here records a gate decision: the gates stay with the runner's
// interactive prompts. The per-case decisions that Gate 2 reviews are the
// human's too; recordCaseDecisions only writes the decisions it is given.

import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { writeJsonAtomic, writeTextAtomic } from './artifact-io.js';
import { releaseExecutionSummary } from './execution-ledger.js';
import {
  applyCaseDecisions,
  draftCases as pendingCases,
} from './case-decisions.js';
import { CONTEXT_SCHEMA } from './run-artifacts.js';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = (/** @type {string} */ name) => join(REPO_DIR, 'schemas', name);

export const DEMO_FIXTURES = join(REPO_DIR, 'examples', 'demo-run');
export const DEMO_STORY_ID = 'DEMO-1';

const TEST_CASES = 'test-cases/DEMO-1.json';
const ANALYSIS = 'analysis/failure-analysis.json';
const BUG_DRAFT = 'release/bug-drafts/BUG-001.md';
const REPORT_JSON = 'release/release-report.json';
const REPORT_MD = 'release/release-report.md';

/** @typedef {{ fixtures: string, workspace: string }} DemoDirs */
/** @typedef {'approved' | 'rejected'} CaseDecision */

/**
 * @param {string} path
 * @returns {any}
 */
const readJsonFile = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Validate and write, or throw with the reason.
 * @param {string} path
 * @param {unknown} value
 * @param {string} schemaPath
 * @param {string} root
 */
function writeValidated(path, value, schemaPath, root) {
  const r = writeJsonAtomic(path, value, { schemaPath, root });
  if (!r.ok) throw new Error(`${relative(root, path)}: ${r.message}`);
}

/**
 * @param {string} workspace
 * @param {Record<string, string>} patch artifact_paths to set
 */
function setPaths(workspace, patch) {
  const p = join(workspace, 'context.json');
  const ctx = readJsonFile(p);
  Object.assign(ctx.artifact_paths, patch);
  writeValidated(p, ctx, CONTEXT_SCHEMA, workspace);
}

/**
 * Seed the workspace with the story and the replayed Analyst output.
 * @param {DemoDirs} dirs
 */
export function startWorkspace({ fixtures, workspace }) {
  mkdirSync(workspace, { recursive: true });
  cpSync(join(fixtures, 'story.md'), join(workspace, 'story.md'));
  const ctx = readJsonFile(join(fixtures, 'context.after-analyst.json'));
  writeValidated(
    join(workspace, 'context.json'),
    ctx,
    CONTEXT_SCHEMA,
    workspace
  );
}

/**
 * The draft cases awaiting a human decision before Gate 2.
 * @param {string} workspace
 * @returns {import('./case-decisions.js').DraftCase[]}
 */
export function draftCases(workspace) {
  const p = join(workspace, TEST_CASES);
  if (!existsSync(p)) return [];
  return pendingCases(readJsonFile(p));
}

/**
 * Write the human's decision on each draft case (Gate 2 then reviews them).
 * @param {string} workspace
 * @param {Record<string, CaseDecision>} decisions by test_case_id
 */
export function recordCaseDecisions(workspace, decisions) {
  const p = join(workspace, TEST_CASES);
  const doc = readJsonFile(p);
  applyCaseDecisions(doc, decisions);
  writeValidated(p, doc, schema('test-cases.schema.json'), workspace);
}

/**
 * Replay the Failure Classifier Agent on the pre-classifier's draft: the
 * planted AC-2 bug must be the one Red failure, as a product bug on TC-002.
 * Anything else means the demo app, tests or classifier changed, and the
 * replayed bug draft would describe a failure that did not happen.
 * @param {DemoDirs} dirs
 */
function replayFailureClassifier({ fixtures, workspace }) {
  const p = join(workspace, ANALYSIS);
  const fa = readJsonFile(p);
  /** @type {{ failure_id: string, severity: string, classification: string, test_case_id: string | null, bug_draft_path?: string }[]} */
  const failures = fa.failures;
  const only = failures.length === 1 ? failures[0] : null;
  if (
    !only ||
    only.severity !== 'red' ||
    only.classification !== 'product_bug' ||
    only.test_case_id !== 'TC-002'
  ) {
    const seen = failures
      .map(
        (f) =>
          `${f.failure_id} ${f.classification}/${f.severity} on ${f.test_case_id}`
      )
      .join('; ');
    throw new Error(
      `the demo expects exactly one Red product_bug on TC-002 (the planted AC-2 bug); the classifier wrote: ${seen || 'no failures'}`
    );
  }
  mkdirSync(join(workspace, dirname(BUG_DRAFT)), { recursive: true });
  cpSync(join(fixtures, BUG_DRAFT), join(workspace, BUG_DRAFT));
  only.bug_draft_path = BUG_DRAFT;
  fa.status = 'finalized';
  writeValidated(p, fa, schema('failure-analysis.schema.json'), workspace);
}

/**
 * Replay the Reporter: the fixture's judgement, with the run's identity and
 * the execution counts derived from this run's ledger (release report 2.0).
 * @param {DemoDirs} dirs
 */
function replayReporter({ fixtures, workspace }) {
  const ctx = readJsonFile(join(workspace, 'context.json'));
  const fa = readJsonFile(join(workspace, ANALYSIS));
  if (fa.status !== 'finalized') {
    throw new Error(`${ANALYSIS} is not finalized`);
  }
  const ledger = readJsonFile(join(workspace, fa.execution_ledger));
  const report = readJsonFile(join(fixtures, REPORT_JSON));
  const red = fa.failures
    .filter((/** @type {{ severity: string }} */ f) => f.severity === 'red')
    .map((/** @type {{ failure_id: string }} */ f) => f.failure_id);
  if (!isDeepStrictEqual(report.blocking_failures, red)) {
    throw new Error(
      `the replayed report blocks on ${report.blocking_failures.join(', ')}, but the Red failures are ${red.join(', ') || 'none'}`
    );
  }
  Object.assign(report, {
    run_id: ctx.run_id,
    story_id: ctx.story.id,
    report_date: new Date().toISOString(),
    execution_summary: releaseExecutionSummary(ledger),
  });
  writeValidated(
    join(workspace, REPORT_JSON),
    report,
    schema('release-report.schema.json'),
    workspace
  );
  const md = renderReport(report);
  const w = writeTextAtomic(join(workspace, REPORT_MD), md, {
    root: workspace,
  });
  if (!w.ok) throw new Error(`${REPORT_MD}: ${w.message}`);
  setPaths(workspace, {
    release_report_json: REPORT_JSON,
    release_report_md: REPORT_MD,
  });
}

/**
 * @param {any} r a release report
 * @returns {string}
 */
function renderReport(r) {
  const e = r.execution_summary;
  const lines = [
    `# Release report: ${r.story_id} (demo run)`,
    '',
    `**Recommendation:** ${r.release_recommendation}`,
    '',
    r.summary,
    '',
    '## Reasoning',
    '',
    r.release_recommendation_reasoning,
    '',
    '## Execution',
    '',
    `${e.passed} passed, ${e.failed} failed, ${e.skipped} skipped of ${e.total}.`,
    '',
    '## Coverage by risk',
    '',
    ...r.coverage_by_risk.map(
      (
        /** @type {{ risk_id: string, status: string, covered_by_tcs: string[] }} */ c
      ) =>
        `- ${c.risk_id}: ${c.status}${c.covered_by_tcs.length ? ` (${c.covered_by_tcs.join(', ')})` : ''}`
    ),
    '',
    '## Bug drafts',
    '',
    ...r.bug_drafts.map(
      (/** @type {{ bug_id: string, severity: string, path: string }} */ b) =>
        `- ${b.bug_id} (${b.severity}): ${b.path}`
    ),
    '',
    '## Open questions',
    '',
    ...r.open_questions.map((/** @type {string} */ q) => `- ${q}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Path to a fixture relative to the workspace, with forward slashes, so the
 * runner (cwd = workspace) resolves it in place.
 * @param {DemoDirs} dirs
 * @param {string} name
 */
function relFixture({ fixtures, workspace }, name) {
  return relative(workspace, join(fixtures, name)).split(sep).join('/');
}

/** @type {Record<string, (dirs: DemoDirs) => void>} */
const REPLAYS = {
  'test-designer': (dirs) => {
    for (const d of ['test-cases', 'planner-input']) {
      cpSync(join(dirs.fixtures, d), join(dirs.workspace, d), {
        recursive: true,
      });
    }
    setPaths(dirs.workspace, {
      test_cases: TEST_CASES,
      planner_brief: 'planner-input/DEMO-1.planner-brief.md',
    });
  },
  planner: (dirs) => {
    cpSync(join(dirs.fixtures, 'specs'), join(dirs.workspace, 'specs'), {
      recursive: true,
    });
    setPaths(dirs.workspace, { playwright_spec: 'specs/DEMO-1.spec.md' });
  },
  // The demo tests are referenced IN PLACE from examples/demo-run/, never
  // copied into a tests/ folder (that is the Generator's, CLAUDE.md §3.2).
  generator: (dirs) =>
    setPaths(dirs.workspace, {
      generated_test: relFixture(dirs, 'tests/demo-broken.spec.ts'),
    }),
  finalize: replayFailureClassifier,
  report: replayReporter,
};

/** The runner steps whose agent output the demo replays. */
export const REPLAYED_STEPS = Object.keys(REPLAYS);

/**
 * Replay the agent output for `step`, if the demo replays that step.
 * @param {string} step the runner's next step
 * @param {DemoDirs} dirs
 * @returns {boolean} whether anything was replayed
 */
export function replayStage(step, dirs) {
  const replay = REPLAYS[step];
  if (!replay) return false;
  replay(dirs);
  return true;
}
