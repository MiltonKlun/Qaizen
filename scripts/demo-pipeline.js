#!/usr/bin/env node
// @ts-check
// Ten-minute offline demo of the whole pipeline (IMPROVEMENT-PLAN Phase 3).
//
// A skeptical coworker experiences all four human gates end-to-end in under
// 10 minutes, FULLY OFFLINE (no Jira, no MCPs, no network), deterministic —
// the demo:healer pattern extended to the whole loop. Nothing is GENERATED
// (so CLAUDE.md §3.8 is not violated): every agent-stage artifact is a
// prefilled fixture from examples/demo-run/ being replayed
// (scripts/lib/demo-stages.js). Only the execute + classify stages are real
// (Playwright actually runs against a local static app; the rule-based
// pre-classifier actually classifies).
//
// What it does:
//   1. Creates an isolated workspace runs/DEMO-1/<run-id>/ with a DEMO
//      sentinel file (so metrics never counts it — IP-3.3).
//   2. Serves examples/demo-run/app/ with node:http on an ephemeral port.
//   3. Drives the REAL runner (scripts/run-pipeline.js) inside the
//      workspace: before each agent (guide) step it replays that agent's
//      output; before Gate 2 it asks you to approve or reject each test
//      case; gates stay INTERACTIVE (experiencing the gates is the point);
//      execute runs Playwright with the demo-only config; classify runs the
//      real pre-classifier. The planted bug (wrong error copy) yields a real
//      FAIL -> product_bug -> BUG-001 draft -> release report 2.0.
//
// Usage:
//   npm run demo:pipeline                # full interactive demo
//   npm run demo:pipeline -- --dry-run   # list the stages; touch no network
//
// Exit codes: 0 ok / dry-run · 1 a gate or case was rejected, or the runner
//   stopped · 2 setup error

import { writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { argv, env, exit, stderr, stdin } from 'node:process';

import {
  DEMO_FIXTURES as FIXTURES,
  draftCases,
  recordCaseDecisions,
  REPLAYED_STEPS,
  replayStage,
  startWorkspace,
} from './lib/demo-stages.js';
import { describeCase } from './lib/case-decisions.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);
const RUNNER = join(SCRIPT_DIR, 'run-pipeline.js');
const SERVE = join(FIXTURES, 'serve.js');
const PW_CONFIG = join(FIXTURES, 'playwright.demo.config.ts');
const DRY = argv.includes('--dry-run');

// The DEMO sentinel filename — metrics skips any run folder containing it.
export const DEMO_SENTINEL = 'DEMO_RUN';

// The agent whose output each replayed step stands in for.
/** @type {Record<string, string>} */
const REPLAYED_AGENT = {
  'test-designer': 'Test Designer',
  planner: 'Playwright Planner',
  generator: 'Playwright Generator',
  finalize: 'Failure Classifier',
  report: 'Reporter',
};

// Prompt mode. The demo's own questions run in a short-lived child process
// that owns the terminal and exits, as each runner call does for its gate,
// so no typed input is left buffered here for the next runner call to read.
// The answer goes to stdout as JSON; the questions go to stderr.
if (argv[2] === '--ask') {
  process.stdout.write(JSON.stringify(await ask(argv[3], argv[4] ?? '')));
  exit(0);
}

// The stage plan, in the order the runner reaches it.
const STAGES = [
  { step: 'analyst', label: 'Analyst → context.json (replayed fixture)' },
  { step: 'gate1', label: 'GATE 1 — Requirement Interpretation (you decide)' },
  {
    step: 'test-designer',
    label: 'Test Designer → test-cases + planner brief',
  },
  {
    step: 'gate2',
    label: 'GATE 2 — Test Scope Approval (you decide each case, then the gate)',
  },
  { step: 'planner', label: 'Planner → spec (replayed fixture)' },
  { step: 'gate3', label: 'GATE 3 — Specs Review (you decide)' },
  { step: 'generator', label: 'Generator → tests (replayed fixtures)' },
  {
    step: 'gate4',
    label: 'GATE 4 — Code Review (human sign-off, always)',
  },
  {
    step: 'execute',
    label: 'Execute → npx playwright test (REAL, demo config)',
  },
  {
    step: 'classify',
    label: 'Classify → ledger + rule-based pre-classifier (REAL)',
  },
  {
    step: 'finalize',
    label: 'Failure Classifier → finalized analysis + BUG-001 (replayed)',
  },
  {
    step: 'report',
    label: 'Reporter → release report 2.0, counts from the ledger',
  },
  { step: 'done', label: 'Done → release report + BUG-001 draft' },
];

function printPlan() {
  console.log('Demo pipeline — stage plan (offline, deterministic):\n');
  for (const s of STAGES) console.log(`  ${s.step.padEnd(14)} ${s.label}`);
  console.log(
    '\nReplayed (fixtures): analyst, test-designer, planner, generator, finalize, report.'
  );
  console.log(
    'Real: execute (Playwright), classify (ledger + pre-classifier).'
  );
  console.log(
    'Interactive: the case decisions and the four gates — that is the point of the demo.'
  );
}

if (DRY) {
  printPlan();
  console.log(
    '\nDRY RUN — no workspace created, no server started, no network.'
  );
  exit(0);
}

// Setup must exist.
if (!existsSync(FIXTURES)) {
  console.error(`Missing demo fixtures at ${FIXTURES}.`);
  exit(2);
}
// The decisions are the human's: the demo has no other way to make them.
if (!stdin.isTTY) {
  console.error(
    'The demo is interactive: run `npm run demo:pipeline` in a terminal (stdin is not a TTY).'
  );
  exit(2);
}

// The reviewer is named once for the whole session, not at every gate.
const named =
  (env.QAIZEN_REVIEWER || '').trim() ||
  (
    spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout || ''
  ).trim();
const REVIEWER = askHuman('reviewer', named)?.reviewer || named;

// ---- 1. isolated workspace + DEMO sentinel ------------------------------
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const WORKSPACE = join(REPO, 'runs', 'DEMO-1', runId);
const dirs = { fixtures: FIXTURES, workspace: WORKSPACE };
startWorkspace(dirs);
writeFileSync(
  join(WORKSPACE, DEMO_SENTINEL),
  'This is a DEMO run (scripts/demo-pipeline.js). Metrics ignore it.\n'
);

// ---- 2. serve the static app in a SEPARATE process ----------------------
// The driver advances the runner with spawnSync (synchronous, blocks this
// process's event loop). An in-process server would be unable to answer the
// browser while Playwright runs, so the server must be its own process. We
// read its ephemeral port from its first stdout line ("PORT <n>").
const serverProc = spawn(process.execPath, [SERVE], {
  stdio: ['ignore', 'pipe', 'inherit'],
});

function cleanup() {
  try {
    serverProc.kill();
  } catch {
    /* already gone */
  }
}

const baseURL = await new Promise((resolveBase, rejectBase) => {
  let buf = '';
  const t = setTimeout(
    () => rejectBase(new Error('demo server did not report a port in time')),
    10000
  );
  serverProc.stdout.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/PORT (\d+)/);
    if (m) {
      clearTimeout(t);
      resolveBase(`http://127.0.0.1:${m[1]}`);
    }
  });
  serverProc.on('exit', (code) => {
    clearTimeout(t);
    rejectBase(new Error(`demo server exited early (code ${code})`));
  });
});
console.log(`Demo app served at ${baseURL} (offline, separate process).`);
console.log(
  `Workspace: runs/DEMO-1/${runId}/  (DEMO sentinel: metrics skip)\n`
);

// ---- 3. drive the real runner stage by stage ----------------------------
// Every gate in this session is decided under one reviewer name.
const ENV = {
  ...process.env,
  BASE_URL: baseURL,
  PIPELINE_PW_CONFIG: PW_CONFIG,
  ...(REVIEWER ? { QAIZEN_REVIEWER: REVIEWER } : {}),
};

/** @returns {{ step: string | null, text: string }} */
function runnerStatus() {
  const r = spawnSync(process.execPath, [RUNNER, '--status'], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    env: ENV,
  });
  const text = r.stdout || '';
  const m = text.match(/Next step:\s*(\S+)/);
  return { step: m ? m[1] : null, text };
}

function advanceRunner() {
  // Interactive: gates inherit our stdin (the human decides); exec steps run.
  const r = spawnSync(process.execPath, [RUNNER, '--resume'], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    env: ENV,
  });
  return r.status;
}

/** @param {string} why */
function stop(why) {
  console.log(`\n${why}`);
  console.log(`Workspace kept at runs/DEMO-1/${runId}/ for inspection.`);
  cleanup();
  exit(1);
}

/**
 * Ask a question in a child process that owns the terminal (see --ask).
 * @param {'reviewer' | 'cases'} kind
 * @param {string} arg
 * @returns {any} the parsed answer, or null when none was given
 */
function askHuman(kind, arg) {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--ask', kind, arg],
    { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Ask the human to approve or reject each draft case: Gate 2 reviews the
 * scope as decided, so the decisions come first.
 * @returns {boolean} whether every case was approved
 */
function decideCases() {
  if (!draftCases(WORKSPACE).length) return true;
  const decisions = askHuman('cases', WORKSPACE);
  if (!decisions) stop('No case decisions were recorded.');
  recordCaseDecisions(WORKSPACE, decisions);
  return Object.values(decisions).every((d) => d === 'approved');
}

try {
  let previous = '';
  for (let guard = 0; ; guard++) {
    if (guard > 50) {
      console.error('Demo did not converge (too many steps) — aborting.');
      exit(2);
    }
    const { step, text } = runnerStatus();
    if (!step) {
      console.error('Could not read runner status — aborting.');
      exit(2);
    }
    // The runner printed its completion message when it finished the run.
    if (step === 'done') break;
    // A step the runner still asks for after its replay and a resume would
    // only repeat: say why and stop instead of looping.
    if (step === previous) {
      stop(
        `The runner is still at "${step}" after the replay. Its status:\n${text}`
      );
    }
    previous = step;

    if (REPLAYED_STEPS.includes(step)) {
      console.log(
        `\n[demo] Replaying the ${REPLAYED_AGENT[step]}'s output from examples/demo-run/ (nothing is generated).`
      );
    }
    try {
      replayStage(step, dirs);
    } catch (e) {
      stop(`The ${step} replay stopped: ${/** @type {Error} */ (e).message}`);
    }
    // The runner goes from the Test Designer straight to Gate 2, which
    // reviews the scope as decided: the case decisions come first.
    if (!decideCases()) {
      stop(
        'A test case was rejected. The replayed spec and tests cover both cases, so the demo stops here (as it should).'
      );
    }

    const code = advanceRunner();
    // A guide step exits 0 after printing its instruction. A gate can open
    // inside any call (the runner moves on from a step to the next gate), so
    // exit 1 is a gate that was rejected, quit or blocked, whatever `step`
    // was; exit 2 is a gate or step whose inputs are not ready.
    if (code === 1) {
      stop(
        'The runner stopped at a gate — the demo stops here (as it should).'
      );
    }
    if (code === 2) {
      stop('The runner stopped (see its message above).');
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('Demo complete. What just happened, end to end:');
  console.log(
    '  - Your case decisions, then four human gates, each recorded with'
  );
  console.log('    opened_at/decided_at and bound to what you reviewed.');
  console.log('  - A REAL Playwright run against the local app.');
  console.log('  - The planted AC-2 bug became FAIL-001 -> product_bug (red)');
  console.log(
    '    -> release/bug-drafts/BUG-001.md -> release report 2.0 (fail).'
  );
  console.log(
    `  - Full traceability DEMO-1 -> RISK -> TC -> SPEC -> PW -> FAIL -> BUG.`
  );
  console.log(`  - Workspace (kept): runs/DEMO-1/${runId}/`);
  console.log(
    '  - DEMO sentinel present => `npm run metrics` ignores this run.'
  );
  console.log('='.repeat(72));
} finally {
  cleanup();
}

/**
 * The questions themselves, run in prompt mode.
 * @param {string | undefined} kind
 * @param {string} arg the default reviewer, or the workspace
 */
async function ask(kind, arg) {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  // Reading lines rather than question() keeps answers typed (or piped)
  // ahead of the prompt. No answer at all ends the prompt with no decision.
  const answer = async (/** @type {string} */ prompt) => {
    stderr.write(prompt);
    const next = await lines.next();
    if (next.done) exit(1);
    return String(next.value).trim();
  };
  try {
    if (kind === 'reviewer') {
      const hint = arg ? ` (press Enter for "${arg}")` : '';
      const name = await answer(`Reviewer for this demo session${hint}: `);
      return { reviewer: name || arg };
    }
    const cases = draftCases(arg);
    stderr.write(
      '\nBefore Gate 2, decide each test case (the gate reviews the scope you decide).\n'
    );
    /** @type {Record<string, 'approved' | 'rejected'>} */
    const decisions = {};
    for (const c of cases) {
      stderr.write(`\n${describeCase(c)}\n`);
      let choice = '';
      while (!['a', 'r'].includes(choice)) {
        choice = (await answer('  Approve or reject? [a/r] ')).toLowerCase();
      }
      decisions[c.test_case_id] = choice === 'a' ? 'approved' : 'rejected';
    }
    return decisions;
  } finally {
    rl.close();
  }
}
