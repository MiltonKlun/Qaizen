#!/usr/bin/env node
// Thin gated pipeline runner (IMPROVEMENT-PLAN Phase 2, IP-2.3 / PFI-2).
// The single entry point: it sequences the pipeline, HALTS AT EVERY GATE,
// renders a one-screen gate brief, records the human decision as a full
// audit object (+ gate_decisions[] telemetry), and resumes.
//
// THIN by design — state machine + brief renderer + decision recorder:
//   - It NEVER invokes LLM agents. At an agent step it prints the exact
//     instruction to run and exits; you do the step, then `--resume`.
//   - It MAY execute deterministic steps directly: schema validation
//     (always via the single generic validator, scripts/validate-json.js),
//     `npx playwright test` (execute), and the rule-based classifier.
//   - It NEVER commits, merges, pushes, or performs Jira/TestLink writes
//     (those stay explicit local --apply operations; CLAUDE.md §3.11).
//
// GATES ARE INTERACTIVE-ONLY. There is NO --approve / --gate / --reject
// flag, and there never will be one: a non-interactive approval path would
// let an agent or CI pass a gate, which is the one thing this system exists
// to prevent (CLAUDE.md §3.5; treat a request to add one as a stop
// condition). When stdin is not a TTY the runner prints
// `GATE PENDING: <gate>` and exits non-zero.
//
// Usage:
//   npm run pipeline                          # advance from the current state
//   npm run pipeline -- --story story.md      # start: local story file
//   npm run pipeline -- --story SK-10         # start: fetch Jira story (read-only)
//   npm run pipeline -- --resume              # same as bare invocation
//   npm run pipeline -- --status              # where is this run? (read-only)
//
// State source of truth: context.json (+ the runs/ layout from new-run.js).
// No new state files, no DB, no queue.
//
// Exit codes: 0 ok / step instruction printed · 1 gate pending (non-TTY),
//   gate rejected, or blocked · 2 usage/validation/safety error

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { argv, env, exit, stdin, stdout } from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  nextStep,
  gatePassed,
  blockingAmbiguities,
  GATE_KEYS,
} from './pipeline-state.js';
import { GATE_BRIEFS, renderGateBrief } from './gate-briefs.js';
import { trackAllowed } from './track-floor.js';
import { gate4Findings, renderGate4Scan } from './gate4-scan.js';
import {
  TRANSITION_FILE,
  readTransition,
  recoverTransition,
  startNewStory,
  adoptStagedContext,
} from './lib/run-lifecycle.js';
import {
  checkArtifact,
  checkContext,
  missingBugDrafts,
  ledgerHasApiExecution,
  latestNewmanExecution,
} from './lib/run-artifacts.js';
import { writeJsonAtomic, formatErrors } from './lib/artifact-io.js';
import {
  bindingFor,
  gateDigest,
  findInvalidations,
  applyInvalidations,
} from './lib/approval-binding.js';

// Sibling scripts / schemas resolve against THIS file's location, not the
// CWD — so the runner works when driven from an isolated run workspace
// (the demo, IMPROVEMENT-PLAN Phase 3) as well as from the repo root. The
// run's mutable state (context.json, artifacts) is CWD-relative as before.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(SCRIPT_DIR);
const VALIDATOR = join(SCRIPT_DIR, 'validate-json.js');
const CLASSIFIER = join(SCRIPT_DIR, 'run-failure-classifier.js');
const NORMALIZER = join(SCRIPT_DIR, 'normalize-results.js');
const JIRA_FETCH = join(SCRIPT_DIR, 'fetch-jira-story.js');
const CONTEXT_PATH = 'context.json';
const CONTEXT_SCHEMA = join(REPO_DIR, 'schemas', 'context.schema.json');
const TEST_CASES_SCHEMA = join(REPO_DIR, 'schemas', 'test-cases.schema.json');

// ---------------------------------------------------------------- safety --
// No flag may ever decide a gate. Reject anything that smells like one, so
// the rule is enforced by the tool itself, not just by documentation.
const FORBIDDEN_FLAGS = /^--(approve|reject|gate|decision|reviewer|yes)\b/;
for (const a of argv.slice(2)) {
  if (FORBIDDEN_FLAGS.test(a)) {
    console.error(
      `Refusing "${a}": gate decisions are interactive-only. There is no\n` +
        'non-interactive approval path, by design (CLAUDE.md §3.5 — the\n' +
        'human gate is the point). See docs/pipeline-runner.md.'
    );
    exit(2);
  }
}

const STATUS_MODE = argv.includes('--status');
const RESUME_MODE = argv.includes('--resume');
const storyIdx = argv.indexOf('--story');
const STORY_ARG =
  storyIdx !== -1 && argv[storyIdx + 1] && !argv[storyIdx + 1].startsWith('--')
    ? argv[storyIdx + 1]
    : null;

// ------------------------------------------------------- flag contract ---
// `--story` STARTS a new run; `--resume` (or no flag) CONTINUES the current
// one; `--status` only reads. These are checked before any fetch or write:
// the old runner staged story.md first and loaded the old context second, so a
// new story could inherit a completed run's gates (finding B3, task group 4.1).
if (storyIdx !== -1 && !STORY_ARG) {
  console.error('--story needs a value: a story file path or a Jira key.');
  exit(2);
}
if (STORY_ARG && RESUME_MODE) {
  console.error(
    '--story starts a NEW run and --resume continues the CURRENT one; use one of them.'
  );
  exit(2);
}
if (STATUS_MODE && (STORY_ARG || RESUME_MODE)) {
  console.error(
    '--status is read-only; it cannot be combined with --story or --resume.'
  );
  exit(2);
}

// ------------------------------------------------------------------ I/O ---
function loadContext() {
  if (!existsSync(CONTEXT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONTEXT_PATH, 'utf8'));
  } catch (e) {
    console.error(`context.json is not valid JSON: ${e.message}`);
    exit(2);
  }
}

function writeContext(context) {
  // Validate the candidate IN MEMORY and write atomically, through the shared
  // implementation behind scripts/validate-json.js (CLAUDE.md §3.3). The old
  // path overwrote context.json first and validated second, so a rejected
  // update was already on disk (finding I6).
  const r = writeJsonAtomic(CONTEXT_PATH, context, {
    schemaPath: CONTEXT_SCHEMA,
  });
  if (!r.ok) {
    console.error(
      'Refusing to update context.json: the new state does not validate. ' +
        'The file on disk was NOT changed.'
    );
    for (const line of formatErrors(r.errors, { includeParams: false })) {
      console.error(line);
    }
    exit(2);
  }
}

function validateJson(schemaPath, dataPath) {
  const r = spawnSync('node', [VALIDATOR, schemaPath, dataPath], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

// Facts the pure state machine cannot know without I/O (IP-2.1 hints).
//
// "Produced" means the artifact exists, is well-formed, validates against its
// schema, and belongs to THIS run (same story id and run id) -- not merely
// that a file exists. Four `{}` files used to satisfy the whole back half of
// the pipeline and print "Run complete" (finding I6, task group 4.2). Every
// artifact that fails is listed in hints.problems so the runner can say WHY a
// step is being asked for again. The Analyst pre-fills conventional paths
// before the files exist; an unset path keeps its plain "not produced" meaning.
function gatherHints(context) {
  const hints = { problems: [] };
  if (!context) return hints;
  const paths = context.artifact_paths || {};
  const check = (key) => {
    const r = checkArtifact(key, context, '.');
    // Only defects are reported; "not produced yet" is ordinary progress.
    if (!r.ok && !r.absent) {
      hints.problems.push(`${key}: ${r.reason}`);
    }
    return r;
  };

  if (paths.test_cases) {
    const tc = check('test_cases');
    hints.testCasesExist = tc.ok;
    if (tc.ok) {
      hints.hasApiCases = (tc.data.test_cases || []).some(
        (c) => c.automation_decision === 'automate_api'
      );
      if (hints.hasApiCases && context.story?.id) {
        hints.apiCollectionExists = existsSync(
          `api-tests/collections/${context.story.id}.postman_collection.json`
        );
        hints.apiExecuted = latestNewmanExecution(context.story.id) !== null;
      }
    }
  }
  if (paths.planner_brief) hints.plannerBriefExists = check('planner_brief').ok;
  if (paths.playwright_spec) hints.specExists = check('playwright_spec').ok;
  if (paths.generated_test)
    hints.generatedTestExists = check('generated_test').ok;
  if (paths.execution_results)
    hints.executionResultsExist = check('execution_results').ok;

  if (paths.failure_analysis) {
    const fa = check('failure_analysis');
    let produced = fa.ok;
    if (fa.ok && /^2\./.test(fa.data.schema_version)) {
      // A 2.x analysis is only as good as the ledger it was derived from.
      const ledger = checkArtifact(
        'execution_ledger',
        {
          ...context,
          artifact_paths: { execution_ledger: fa.data.execution_ledger },
        },
        '.'
      );
      if (!ledger.ok) {
        hints.problems.push(`execution_ledger: ${ledger.reason}`);
        produced = false;
      } else if (hints.hasApiCases && !ledgerHasApiExecution(ledger.data)) {
        hints.problems.push(
          'execution_ledger: has no Newman execution for this API story; re-classify after the API run'
        );
        produced = false;
      }
    }
    hints.failureAnalysisExists = produced;
    if (produced) {
      hints.failureAnalysisFinalized = fa.data.status === 'finalized';
      const missing = hints.failureAnalysisFinalized
        ? missingBugDrafts(fa.data, '.')
        : [];
      hints.bugDraftsMissing = missing.length;
      if (missing.length) {
        hints.problems.push(
          `failure_analysis: no bug draft on disk for Red failure(s) ${missing.join(', ')}`
        );
      }
    }
  }
  if (paths.release_report_json)
    hints.releaseReportExists = check('release_report_json').ok;
  return hints;
}

// ------------------------------------------------- gate decision recorder --
/**
 * Apply a human gate decision to the context (exported for unit tests; the
 * CLI only calls this AFTER an interactive TTY session captured the
 * decision). Writes the gateValue audit object and appends the
 * gate_decisions[] telemetry event. Returns the same context, mutated.
 */
export function applyGateDecision(
  context,
  gateKey,
  { decision, reviewer, notes, openedAt, decidedAt, bindings = {} }
) {
  const approved = decision === 'approved';
  // `bindings` is computed by the I/O code at the moment of the human
  // decision (scripts/lib/approval-binding.js): the digest of exactly what
  // was reviewed. Recorded on approval only (task group 4.3).
  context.review_gates[gateKey] = {
    status: approved,
    reviewer: reviewer || null,
    reviewed_at: decidedAt,
    opened_at: openedAt,
    notes: notes || null,
    ...(approved ? (bindings[gateKey] ?? {}) : {}),
  };
  // The lite consolidated gate (qa_scope_approved) ALSO sets the two
  // underlying gates so a tool that only knows the four-gate model still
  // sees Gates 1+2 as passed (docs/review-gates.md "How to consolidate").
  // Only on approval — a rejection leaves them untouched.
  if (gateKey === 'qa_scope_approved' && approved) {
    for (const k of ['requirements_reviewed', 'test_scope_reviewed']) {
      context.review_gates[k] = {
        status: true,
        reviewer: reviewer || null,
        reviewed_at: decidedAt,
        opened_at: openedAt,
        notes: `Consolidated via qa_scope_approved (lite track).`,
        ...(bindings[k] ?? {}),
      };
    }
  }
  if (!Array.isArray(context.gate_decisions)) context.gate_decisions = [];
  context.gate_decisions.push({
    gate: gateKey,
    decision,
    opened_at: openedAt,
    decided_at: decidedAt,
    reviewer: reviewer || null,
    notes: notes || null,
  });
  // Gate 1 approval moves the run out of draft (docs/context-json-guide.md §2).
  if (
    approved &&
    (gateKey === 'requirements_reviewed' || gateKey === 'qa_scope_approved') &&
    context.status === 'draft'
  ) {
    context.status = 'in_progress';
  }
  return context;
}

// What to redo when a gate is rejected (docs/review-gates.md "On rejection").
const REDO_AFTER_REJECT = {
  gate1: 'Re-run agents/analyst.md with the correction notes, then --resume.',
  gate2:
    'Re-run agents/test-designer.md (fix the named TCs / the planner brief), then --resume.',
  qa_scope:
    'Lite consolidated gate: re-run agents/analyst.md and/or agents/test-designer.md per the notes, then --resume. (Or raise the track to standard if the story is not routine.)',
  gate3:
    'Fix planner-input/<story>.planner-brief.md and re-run the Playwright Planner, then --resume.',
  gate4:
    'Re-run the Playwright Generator with corrections, or edit the test manually (the one gate where direct human edits are normal), then --resume.',
};

async function runGateInteractive(step, context) {
  const gateKey = GATE_KEYS[step];

  // Broken machine-readable inputs are not a judgment call: the gate does not
  // even prompt until they exist and validate (task group 4.2). The old
  // runner printed "ATTENTION: failing validation" and asked for approval
  // anyway, so human judgment could wave through a broken contract.
  const broken = gateInputProblems(step, context);
  if (broken.length) {
    console.error(
      `Gate ${gateKey} cannot be reviewed yet: its inputs are not valid.`
    );
    for (const b of broken) console.error(`  - ${b}`);
    console.error(
      'Fix them (re-run the step that produces them), then --resume.'
    );
    exit(2);
  }

  if (!stdin.isTTY) {
    console.error(`GATE PENDING: ${gateKey}`);
    console.error(
      'Gate decisions are interactive-only (no flags, no piped stdin). Run\n' +
        '`npm run pipeline` in a terminal to review and decide this gate.'
    );
    exit(1);
  }

  const openedAt = new Date().toISOString();
  // The inputs this decision will be bound to, as they are while the brief is
  // on screen. If they change before the decision, the reviewer approved
  // something that no longer exists, so the approval is refused.
  const boundGates =
    gateKey === 'qa_scope_approved'
      ? ['qa_scope_approved', 'requirements_reviewed', 'test_scope_reviewed']
      : [gateKey];
  const reviewedDigests = Object.fromEntries(
    boundGates.map((g) => [g, gateDigest(g, context, '.')])
  );

  // Gather + validate the artifacts this gate reviews, then render the brief.
  const artifacts = GATE_BRIEFS[step]
    .artifacts(context)
    .filter(Boolean)
    .map((p) => {
      const exists = existsSync(p);
      let valid = null;
      if (exists && p.endsWith('.json')) {
        const schema =
          p === CONTEXT_PATH
            ? CONTEXT_SCHEMA
            : p === context.artifact_paths?.test_cases
              ? TEST_CASES_SCHEMA
              : null;
        if (schema) valid = validateJson(schema, p);
      }
      return { path: p, exists, valid };
    });
  console.log(renderGateBrief({ step, context, artifacts }));

  // Gate 4: run the static pre-Gate-4 scan on the generated test and surface
  // its mechanical findings as the "auto-checks" half of the review, so the
  // human opens the gate with the mechanical questions pre-answered and can
  // spend their attention on business correctness (IP-6.4). Informational —
  // it never decides the gate.
  if (step === 'gate4') {
    const testPath = context.artifact_paths?.generated_test;
    if (testPath && existsSync(testPath)) {
      console.log('');
      console.log(
        renderGate4Scan(testPath, gate4Findings(readFileSync(testPath, 'utf8')))
      );
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    let decision = '';
    while (decision === '') {
      const a = (
        await rl.question('Decision — [a]pprove / [r]eject / [q]uit: ')
      )
        .trim()
        .toLowerCase();
      if (a === 'q' || a === 'quit') {
        console.log('No decision recorded; the gate stays as it was.');
        exit(1);
      }
      if (a === 'a' || a === 'approve' || a === 'approved')
        decision = 'approved';
      else if (a === 'r' || a === 'reject' || a === 'rejected')
        decision = 'rejected';
    }

    const gitName = spawnSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
    });
    const defaultReviewer = (gitName.stdout || '').trim();
    const enterHint = defaultReviewer
      ? ` (press Enter for "${defaultReviewer}")`
      : '';
    let reviewerAnswer = await rl.question(`Reviewer name${enterHint}: `);
    // "Reviewer:" was once mistaken for a yes/no prompt (answered "y"), which
    // put junk in the audit trail. If the answer looks like a yes/no, re-ask
    // once for the actual name.
    if (/^(y|n|yes|no)$/i.test(reviewerAnswer.trim())) {
      reviewerAnswer = await rl.question(
        `That looks like a yes/no — please type the reviewer's NAME` +
          `${defaultReviewer ? ` (Enter = ${defaultReviewer})` : ''}: `
      );
    }
    const reviewer = reviewerAnswer.trim() || defaultReviewer || null;

    let notes = (
      await rl.question(
        decision === 'rejected'
          ? 'Notes (REQUIRED for a rejection — what must change): '
          : 'Notes (optional): '
      )
    ).trim();
    while (decision === 'rejected' && !notes) {
      notes = (
        await rl.question('A rejection needs a reason — what must change: ')
      ).trim();
    }

    const bindings = Object.fromEntries(
      boundGates.map((g) => [g, bindingFor(g, context, '.')])
    );
    const moved = boundGates.filter(
      (g) => bindings[g].input_digest !== reviewedDigests[g]
    );
    if (decision === 'approved' && moved.length) {
      console.error(
        `The inputs of ${moved.join(', ')} changed while the brief was open. ` +
          'Nothing was recorded; re-run to review what exists now.'
      );
      exit(1);
    }
    applyGateDecision(context, gateKey, {
      decision,
      reviewer,
      notes,
      openedAt,
      decidedAt: new Date().toISOString(),
      bindings,
    });
    writeContext(context);

    if (decision === 'rejected') {
      console.log(`\n${gateKey}: REJECTED — recorded in gate_decisions[].`);
      console.log(`To redo: ${REDO_AFTER_REJECT[step]}`);
      exit(1);
    }
    console.log(
      `\n${gateKey}: approved — recorded with telemetry and bound to the reviewed inputs.`
    );
  } finally {
    rl.close();
  }
}

// ------------------------------------------------------------ step output --
function storyId(context) {
  return context?.story?.id || '<story-id>';
}

const GUIDE_STEPS = {
  analyst: (ctx) =>
    'Run the ANALYST: agents/analyst.md against story.md.\n' +
    '  It writes context.json (risks, ACs, ambiguities; all gates false).\n' +
    stagedRunLine() +
    '  Then: node scripts/validate-json.js schemas/context.schema.json context.json\n' +
    '  Then: npm run pipeline -- --resume',
  'test-designer': (ctx) =>
    `Run the TEST DESIGNER: agents/test-designer.md for ${storyId(ctx)}.\n` +
    `  It writes test-cases/${storyId(ctx)}.json + planner-input/${storyId(ctx)}.planner-brief.md\n` +
    '  and fills artifact_paths.test_cases / .planner_brief in context.json.\n' +
    '  Then: npm run pipeline -- --resume',
  planner: (ctx) =>
    `Run the PLAYWRIGHT PLANNER native agent with planner-input/${storyId(ctx)}.planner-brief.md\n` +
    `  (it explores the real app via Playwright MCP — never from text alone, CLAUDE.md §3.8).\n` +
    `  It writes specs/${storyId(ctx)}.md; fill artifact_paths.playwright_spec.\n` +
    '  Then: npm run pipeline -- --resume',
  api: (ctx) =>
    `Run the API AGENT: agents/api-agent.md for the automate_api cases of ${storyId(ctx)}.\n` +
    `  It writes api-tests/collections/${storyId(ctx)}.postman_collection.json (+ environment),\n` +
    '  verifying endpoint shapes via Postman MCP / OpenAPI — never invented.\n' +
    '  Then: npm run pipeline -- --resume',
  generator: (ctx) =>
    `Run the PLAYWRIGHT GENERATOR native agent on specs/${storyId(ctx)}.md.\n` +
    `  It writes tests/${storyId(ctx)}.spec.ts; fill artifact_paths.generated_test.\n` +
    '  Then: npm run pipeline -- --resume',
  'execute-api': (ctx) =>
    `Run the API BRANCH for ${storyId(ctx)}: this story has automate_api cases and\n` +
    '  no Newman execution yet. It must run before the failure analysis, or the\n' +
    '  run would complete on the E2E half alone.\n' +
    `  npm run test:api -- ${storyId(ctx)}\n` +
    '  Then: npm run pipeline -- --resume   (classify then includes the API results)',
  finalize: (ctx) =>
    `Run the FAILURE CLASSIFIER: agents/failure-classifier.md for ${storyId(ctx)}.\n` +
    '  The rule-based pre-classifier wrote a DRAFT analysis. Confirm or correct each\n' +
    '  classification, write release/bug-drafts/BUG-XXX.md for every Red failure and set\n' +
    '  its bug_draft_path, resolve or acknowledge unresolved links, then set\n' +
    '  status: "finalized" in analysis/failure-analysis.json.\n' +
    '  Then: npm run pipeline -- --resume',
  report: (ctx) =>
    `Run the REPORTER: agents/reporter.md for ${storyId(ctx)}.\n` +
    '  It writes release/release-report.{md,json} from the FINALIZED failure analysis\n' +
    '  (summaries only) and fills artifact_paths.release_report_md/_json.\n' +
    '  It does not set context.json status; the runner does, after validating.\n' +
    '  Then: npm run pipeline -- --resume   (the run completes)',
};

/**
 * Why a gate's mechanical inputs are not ready (empty when they are).
 * '@context' / '@story' are the run's context.json and story file; the rest
 * are artifact_paths keys checked through the shared validator.
 */
function gateInputProblems(step, context) {
  const problems = [];
  for (const req of GATE_BRIEFS[step]?.requires ?? []) {
    if (req === '@context') {
      const c = checkContext(context);
      if (!c.ok) problems.push(`context.json ${c.reason}`);
    } else if (req === '@story') {
      const story = context?.story?.path || 'story.md';
      if (!existsSync(story) || !readFileSync(story, 'utf8').trim()) {
        problems.push(`the story file ${story} is missing or empty`);
      }
    } else {
      const r = checkArtifact(req, context, '.');
      if (!r.ok) problems.push(`${req} ${r.reason}`);
      // The per-case decisions are part of the scope being approved, so they
      // are made BEFORE the approval (task group 4.3). Flipping them after
      // it would change the reviewed test cases and make the approval stale.
      if (
        req === 'test_cases' &&
        r.ok &&
        (step === 'gate2' || step === 'qa_scope')
      ) {
        const drafts = (r.data.test_cases ?? [])
          .filter((c) => c.status === 'draft')
          .map((c) => c.test_case_id);
        if (drafts.length) {
          problems.push(
            `test case(s) ${drafts.join(', ')} are still "draft": set each to "approved" or ` +
              '"rejected" in the test-cases file first — the per-case decisions are part of the scope you approve'
          );
        }
      }
    }
  }
  return problems;
}

function execStep(step, context) {
  if (step === 'execute') {
    // PIPELINE_PW_CONFIG lets a caller point Playwright at a non-root config
    // (the demo uses examples/demo-run/playwright.demo.config.ts so its specs
    // never touch the root tests/ folder owned by the Generator, CLAUDE.md
    // §3.2). Absent => the repo-root playwright.config.ts as usual.
    //
    // Playwright resolves @playwright/test from its CWD upward, so it must run
    // where node_modules lives (the repo root). When a custom config is set
    // (the demo, driven from a workspace), we run Playwright with cwd=repo and
    // tell the config where to write reports via PIPELINE_REPORT_DIR — so the
    // report lands in the workspace the classifier then reads.
    const pwArgs = ['playwright', 'test'];
    const customConfig = env.PIPELINE_PW_CONFIG;
    if (customConfig) pwArgs.push('--config', customConfig);
    const cwd = customConfig ? REPO_DIR : process.cwd();
    const reportDir = customConfig ? join(process.cwd(), 'reports') : 'reports';
    console.log(
      `Executing: npx ${pwArgs.join(' ')}  (failures are DATA for the`
    );
    console.log('classifier, not a runner error)\n');
    const run = spawnSync('npx', pwArgs, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...env, PIPELINE_REPORT_DIR: reportDir },
    });
    // A failing SUITE is data for the classifier. A runner that could not
    // start, or that produced no valid report of THIS code, is not: the old
    // runner ignored this result and looped, relaunching the executor while
    // the report stayed absent (finding B4; nine launches in 1.6 s).
    if (run.error) {
      console.error(
        `Could not launch the test runner (${run.error.message}). No report was produced; stopping.`
      );
      exit(2);
    }
    const p = context.artifact_paths;
    const candidate = {
      ...context,
      artifact_paths: {
        ...p,
        execution_results: p.execution_results || 'reports/results.json',
      },
    };
    const report = checkArtifact('execution_results', candidate, '.');
    if (!report.ok) {
      console.error(
        `The test runner exited ${run.status ?? `by signal ${run.signal}`} without a valid report for this code: ` +
          `execution_results ${report.reason}.`
      );
      console.error(
        'This is an execution/startup error, not a failing suite; stopping after one launch.'
      );
      exit(2);
    }
    if (run.status !== 0) {
      console.log(
        `\nThe suite exited ${run.status} with a valid report: failures are data; continuing to classification.`
      );
    }
    if (!p.execution_results) p.execution_results = 'reports/results.json';
    if (!p.html_report) p.html_report = 'reports/html';
    if (!p.traces) p.traces = 'reports/traces';
    if (!p.screenshots) p.screenshots = 'reports/screenshots';
    writeContext(context);
    return true;
  }
  if (step === 'classify') {
    // The classifier reads the normalized execution ledger, never raw reports
    // (task group 3.3), so the run's reports are normalized first. The run id
    // is passed through so the classifier can refuse a ledger from another run.
    const ledgerPath = 'analysis/execution-ledger.json';
    const normalizeArgs = [
      NORMALIZER,
      '--story',
      storyId(context),
      '--playwright',
      context.artifact_paths.execution_results || 'reports/results.json',
      '--out',
      ledgerPath,
    ];
    if (context.run_id) normalizeArgs.push('--run-id', context.run_id);
    // This story's Newman reports from ONE execution: the one named by
    // QAIZEN_EXECUTION_ID when it holds them, otherwise the newest that does.
    const pinned = env.QAIZEN_EXECUTION_ID;
    const apiExecution =
      pinned && existsSync(join('reports', pinned, 'newman', storyId(context)))
        ? pinned
        : latestNewmanExecution(storyId(context));
    if (apiExecution) normalizeArgs.push('--execution', apiExecution);
    console.log('Normalizing the run into an execution ledger\n');
    const n = spawnSync('node', normalizeArgs, { stdio: 'inherit' });
    if (n.status !== 0) {
      console.error(
        'Normalization did not complete (see output above). Fix and --resume.'
      );
      exit(2);
    }
    context.artifact_paths.execution_ledger = ledgerPath;

    console.log('\nClassifying failures: the rule-based pre-classifier\n');
    const r = spawnSync('node', [CLASSIFIER, '--ledger', ledgerPath], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      console.error(
        'Classifier did not complete (see output above). Fix and --resume.'
      );
      exit(2);
    }
    if (!context.artifact_paths.failure_analysis) {
      context.artifact_paths.failure_analysis =
        'analysis/failure-analysis.json';
    }
    if (!context.artifact_paths.bug_drafts_dir) {
      context.artifact_paths.bug_drafts_dir = 'release/bug-drafts';
    }
    writeContext(context);
    return true;
  }
  return false;
}

// --------------------------------------------------------------- status ---
/**
 * The run as it stands once stale approvals are taken into account, WITHOUT
 * writing anything (for --status and completion checks).
 */
function currentView(context) {
  if (!context) return { view: context, invalidations: [] };
  const invalidations = findInvalidations(context, '.');
  if (!invalidations.length) return { view: context, invalidations };
  const view = applyInvalidations(structuredClone(context), invalidations);
  return { view, invalidations };
}

function printStatus(context, hints) {
  if (!context) {
    console.log('No run in progress (no context.json).');
    console.log(
      'Next step: analyst   (start with: npm run pipeline -- --story <path|JIRA-KEY>)'
    );
    return;
  }
  const gates = context.review_gates || {};
  const mark = (k) => (gatePassed(gates[k]) ? 'PASSED' : 'pending');
  console.log(`Story:  ${storyId(context)}  ·  status: ${context.status}`);
  console.log(
    `Gates:  G1 ${mark('requirements_reviewed')} · G2 ${mark('test_scope_reviewed')} · G3 ${mark('specs_reviewed')} · G4 ${mark('code_reviewed')}`
  );
  if (gates.qa_scope_approved !== undefined) {
    console.log(
      `        qa_scope_approved (G1+G2 consolidated): ${mark('qa_scope_approved')}`
    );
  }
  const blocked = blockingAmbiguities(context);
  if (blocked.length > 0) {
    console.log(`BLOCKED by ${blocked.length} ambiguity(ies):`);
    for (const b of blocked) console.log(`  - ${b}`);
    return;
  }
  const ctx = checkContext(context);
  if (!ctx.ok) console.log(`INVALID: context.json ${ctx.reason}`);
  for (const pr of hints.problems ?? []) console.log(`Not accepted: ${pr}`);
  console.log(`Next step: ${nextStep(context, hints)}`);
}

/**
 * Progress guard for one invocation: true when the same step is about to run
 * again on unchanged validated state (the same hints and the same context).
 * An exec step that "succeeds" without changing what the state machine sees
 * would otherwise repeat forever (finding B4, task group 4.2).
 */
export function progressGuard() {
  const seen = new Set();
  return (step, hints, context) => {
    const key = [step, JSON.stringify(hints), JSON.stringify(context)].join(
      '\u0000'
    );
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
}

/** The staged run id the Analyst must preserve, when a run is staged. */
function stagedRunLine() {
  const rec = readTransition('.');
  if (rec?.phase !== 'installed') return '';
  return (
    `  Use run_id "${rec.new_story.run_id}" for this run (staged by the runner; ` +
    `recorded in ${TRANSITION_FILE}). Do not mint a new one.\n`
  );
}

/**
 * Has the current run finished? Only by the validated definition: a
 * `status: "completed"` set by hand or by an agent is not proof (task group
 * 4.2), because the old Reporter set it on file existence alone.
 */
function runIsComplete(context) {
  if (!context || !checkContext(context).ok) return false;
  // A stale approval means the run is not complete (task group 4.3).
  const { view } = currentView(context);
  return nextStep(view, gatherHints(view)) === 'done';
}

// ----------------------------------------------------------------- main ---
async function main() {
  // --status reads and reports; it never recovers, stages or writes anything.
  if (STATUS_MODE) {
    const context = loadContext();
    const pending = readTransition('.');
    if (pending && pending.phase !== 'installed') {
      console.log(
        `An interrupted new-story transition is pending (${TRANSITION_FILE}, phase "${pending.phase}").`
      );
      console.log(
        '  It is finished or undone by: npm run pipeline -- --resume'
      );
    } else if (pending?.phase === 'installed' && !context) {
      console.log(
        `Staged run ${pending.new_story.run_id} (${pending.new_story.ref}) is waiting for the Analyst.`
      );
    }
    const { view, invalidations } = currentView(context);
    for (const inv of invalidations) {
      console.log(
        `Stale approval: ${inv.gate} — ${inv.reason} (the next --resume returns it to pending).`
      );
    }
    printStatus(view, gatherHints(view));
    exit(0);
  }

  // An interrupted transition is finished or undone BEFORE anything else
  // reads the run state (docs/pipeline-runner.md, "Starting a new story").
  const recovered = recoverTransition('.');
  if (!recovered.ok) {
    console.error(recovered.message);
    exit(2);
  }
  if (recovered.message) console.log(recovered.message + '\n');

  // --story: a NEW run. Decided before anything is written.
  if (STORY_ARG) {
    const current = loadContext();
    const started = startNewStory({
      root: '.',
      ref: STORY_ARG,
      context: current,
      complete: runIsComplete(current),
      fetchJira: (key, out) => {
        console.log(`Fetching ${key} from Jira (read-only)...`);
        const r = spawnSync('node', [JIRA_FETCH, key, '--out', out], {
          stdio: 'inherit',
        });
        return r.status ?? 2;
      },
    });
    if (!started.ok) {
      console.error(started.message);
      exit(started.code);
    }
    console.log(started.message);
    console.log(`New run ${started.runId} staged from ${STORY_ARG}.\n`);
  }

  let context = loadContext();

  // The Analyst has answered a staged run: accept its context only if it is
  // that run (same run id, unchanged story).
  const staged = readTransition('.');
  if (context && staged?.phase === 'installed') {
    const adopted = adoptStagedContext('.', context, staged);
    if (!adopted.ok) {
      console.error('Refusing to continue with this context.json:');
      console.error(adopted.message);
      exit(2);
    }
    console.log(adopted.message + '\n');
  }

  // Blocking ambiguities halt everything (CLAUDE.md §3.7).
  const blocked = blockingAmbiguities(context);
  if (blocked.length > 0) {
    console.error('BLOCKED — blocking ambiguities must be resolved first:');
    for (const b of blocked) console.error(`  - ${b}`);
    console.error(
      'Resolve with the human, update context.json, then --resume.'
    );
    exit(1);
  }

  // Track-floor enforcement (Phase 4, lite track). A story may not run `lite`
  // when its floor is higher: Red-taxonomy exposure or size pushes it to
  // standard (scripts/track-floor.js, docs/healer-guardrails.md §4). The floor
  // is computed live and is read-only here — the runner never rewrites
  // context.json just to advance, preserving the "a refusal writes nothing"
  // guarantee. The analyst records track_floor in the manifest (IP-4.5).
  if (context && context.track === 'lite') {
    const { allowed, minimum, reasons } = trackAllowed(context, 'lite');
    if (!allowed) {
      console.error(
        `Refusing track "lite": the floor for this story is "${minimum}".`
      );
      console.error('Reasons the floor is higher than lite:');
      for (const r of reasons) console.error(`  - ${r}`);
      console.error(
        'High-consequence or non-routine stories keep the four gates. Set\n' +
          '`track` to "standard" (or remove it) in context.json, then --resume.'
      );
      exit(2);
    }
  }

  // Advance: exec steps run and continue; gates are decided interactively
  // and continue; agent (guide) steps print the instruction and stop.
  // Everything below reads context.json as the run's truth, so it must be
  // valid before any step is derived from it (task group 4.2).
  if (context) {
    const valid = checkContext(context);
    if (!valid.ok) {
      console.error(`context.json ${valid.reason}; fix it before resuming.`);
      exit(2);
    }
  }

  // Approvals are bound to what they reviewed (task group 4.3). One that no
  // longer matches -- or that predates binding -- returns to pending here,
  // with a separate invalidation event; the human's decision history in
  // gate_decisions[] is never rewritten, and no rejection is invented.
  if (context) {
    const invalidations = findInvalidations(context, '.');
    if (invalidations.length) {
      applyInvalidations(context, invalidations);
      writeContext(context);
      console.log(
        'Approvals returned to pending (they no longer match what they reviewed):'
      );
      for (const inv of invalidations)
        console.log(`  - ${inv.gate}: ${inv.reason}`);
      console.log('');
    }
  }

  // Progress guard: the same step on unchanged validated state must not be
  // attempted twice in one invocation. An exec step that "succeeds" without
  // changing what the state machine sees would otherwise loop forever.
  const repeated = progressGuard();
  let reported = '';
  for (;;) {
    const hints = gatherHints(context);
    const step = nextStep(context, hints);
    const problems = (hints.problems ?? []).join('\n');
    if (problems && problems !== reported) {
      console.log(
        'Not accepted as produced (so the step that makes them is next):'
      );
      for (const pr of hints.problems) console.log(`  - ${pr}`);
      console.log('');
      reported = problems;
    }
    if (repeated(step, hints, context)) {
      console.error(
        `No progress: step "${step}" ran and nothing it should produce changed. ` +
          'Stopping instead of repeating it.'
      );
      exit(2);
    }

    if (step === 'done') {
      // Completion is the runner's call, made only on validated state: every
      // gate passed, execution evidence, a finalized analysis with a bug
      // draft per Red failure, and a valid release report for this run.
      if (context.status !== 'completed') {
        context.status = 'completed';
        writeContext(context);
      }
      const rr = checkArtifact('release_report_json', context, '.');
      const verdict = rr.ok ? rr.data.release_recommendation : 'unknown';
      console.log(
        'Pipeline complete: every gate passed and every artifact validated.'
      );
      console.log(
        `Release recommendation: ${verdict}. "Pipeline complete" is not "release passed".`
      );
      console.log(
        'Start the next story with: npm run pipeline -- --story <path|JIRA-KEY>\n' +
          '  (this run is archived automatically and verified before anything is replaced),\n' +
          `or archive it now: npm run new-run -- ${storyId(context)}   ·   then npm run session-summary -- --friction "..."`
      );
      exit(0);
    }
    if (GUIDE_STEPS[step]) {
      console.log(
        `Next step: ${step.toUpperCase()} (agent step — the runner never runs LLM agents)\n`
      );
      console.log(GUIDE_STEPS[step](context));
      exit(0);
    }
    if (GATE_KEYS[step]) {
      await runGateInteractive(step, context); // exits on reject/quit/non-TTY
      continue;
    }
    if (execStep(step, context)) continue;
    console.error(`Unknown step "${step}" — this is a bug in the runner.`);
    exit(2);
  }
}

// Only run when invoked as a CLI (the module is also imported by tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error(e?.stack || String(e));
    exit(2);
  });
}
