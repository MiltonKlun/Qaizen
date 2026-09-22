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
  writeFileSync(CONTEXT_PATH, JSON.stringify(context, null, 2) + '\n');
  // Always re-validate through the single generic validator (CLAUDE.md §3.3).
  const r = spawnSync('node', [VALIDATOR, CONTEXT_SCHEMA, CONTEXT_PATH], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(
      `context.json failed schema validation after the update:\n${r.stdout}${r.stderr}`
    );
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
function gatherHints(context) {
  const hints = {};
  const paths = context?.artifact_paths || {};
  const tc = paths.test_cases;
  // Existence overrides for the artifact-producing steps. The Analyst
  // pre-fills test_cases / planner_brief with conventional paths before the
  // files exist; without these hints the pure state machine would read those
  // prefilled strings as "produced" and skip the step that creates them
  // (pipeline-state.js `produced`). Only set the hint when the path is filled,
  // so an empty path keeps its plain "not yet produced" meaning.
  if (tc) hints.testCasesExist = existsSync(tc);
  if (paths.planner_brief)
    hints.plannerBriefExists = existsSync(paths.planner_brief);
  if (paths.playwright_spec)
    hints.specExists = existsSync(paths.playwright_spec);
  if (paths.generated_test)
    hints.generatedTestExists = existsSync(paths.generated_test);
  if (tc && existsSync(tc)) {
    try {
      const parsed = JSON.parse(readFileSync(tc, 'utf8'));
      hints.hasApiCases = (parsed.test_cases || []).some(
        (c) => c.automation_decision === 'automate_api'
      );
      if (hints.hasApiCases && context?.story?.id) {
        hints.apiCollectionExists = existsSync(
          `api-tests/collections/${context.story.id}.postman_collection.json`
        );
      }
    } catch {
      /* unreadable test-cases: the gate brief will surface it */
    }
  }
  if (paths.execution_results)
    hints.executionResultsExist = existsSync(paths.execution_results);
  if (paths.failure_analysis)
    hints.failureAnalysisExists = existsSync(paths.failure_analysis);
  if (paths.release_report_json)
    hints.releaseReportExists = existsSync(paths.release_report_json);
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
  { decision, reviewer, notes, openedAt, decidedAt }
) {
  const approved = decision === 'approved';
  context.review_gates[gateKey] = {
    status: approved,
    reviewer: reviewer || null,
    reviewed_at: decidedAt,
    opened_at: openedAt,
    notes: notes || null,
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

  if (!stdin.isTTY) {
    console.error(`GATE PENDING: ${gateKey}`);
    console.error(
      'Gate decisions are interactive-only (no flags, no piped stdin). Run\n' +
        '`npm run pipeline` in a terminal to review and decide this gate.'
    );
    exit(1);
  }

  const openedAt = new Date().toISOString();

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

    applyGateDecision(context, gateKey, {
      decision,
      reviewer,
      notes,
      openedAt,
      decidedAt: new Date().toISOString(),
    });
    writeContext(context);

    if (decision === 'rejected') {
      console.log(`\n${gateKey}: REJECTED — recorded in gate_decisions[].`);
      console.log(`To redo: ${REDO_AFTER_REJECT[step]}`);
      exit(1);
    }
    console.log(`\n${gateKey}: approved — recorded with telemetry.`);
    if (step === 'gate2') {
      console.log(
        'Reminder: set per-TC status to approved/rejected in the test-cases\n' +
          'file (Test Designer ownership — the runner does not edit it).'
      );
    }
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
  report: (ctx) =>
    `Run the REPORTER: agents/reporter.md for ${storyId(ctx)}.\n` +
    '  It writes release/release-report.{md,json} from the failure analysis\n' +
    '  (summaries only) and fills artifact_paths.release_report_md/_json.\n' +
    '  Then: npm run pipeline -- --resume   (the run completes)',
};

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
    spawnSync('npx', pwArgs, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...env, PIPELINE_REPORT_DIR: reportDir },
    });
    const p = context.artifact_paths;
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
    if (env.QAIZEN_EXECUTION_ID) {
      normalizeArgs.push('--execution', env.QAIZEN_EXECUTION_ID);
    }
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
  console.log(`Next step: ${nextStep(context, hints)}`);
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

/** Has the current run finished? The runner's own definition, or the record. */
function runIsComplete(context) {
  if (!context) return false;
  return (
    context.status === 'completed' ||
    nextStep(context, gatherHints(context)) === 'done'
  );
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
    printStatus(context, gatherHints(context));
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
  for (;;) {
    const step = nextStep(context, gatherHints(context));

    if (step === 'done') {
      console.log('Run complete: release report produced, all gates passed.');
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
