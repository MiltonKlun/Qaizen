#!/usr/bin/env node
// Ten-minute offline demo of the whole pipeline (IMPROVEMENT-PLAN Phase 3).
//
// A skeptical coworker experiences all four human gates end-to-end in under
// 10 minutes, FULLY OFFLINE (no Jira, no MCPs, no network), deterministic —
// the demo:healer pattern extended to the whole loop. Nothing is GENERATED
// (so CLAUDE.md §3.8 is not violated): every agent-stage artifact is a
// prefilled fixture from examples/demo-run/ being replayed. Only the
// execute + classify stages are real (Playwright actually runs against a
// local static app; the rule-based classifier actually classifies).
//
// What it does:
//   1. Creates an isolated workspace runs/DEMO-1/<run-id>/ with a DEMO
//      sentinel file (so metrics never counts it — IP-3.3).
//   2. Serves examples/demo-run/app/ with node:http on an ephemeral port.
//   3. Drives the REAL runner (scripts/run-pipeline.js) inside the
//      workspace: before each agent (guide) step it copies the next fixture
//      in; gates stay INTERACTIVE (experiencing the gates is the point);
//      execute runs Playwright with the demo-only config; classify runs the
//      real classifier. The planted bug (wrong error copy) yields a real
//      FAIL -> product_bug -> BUG-001 draft -> release report.
//
// Usage:
//   npm run demo:pipeline                # full interactive demo
//   npm run demo:pipeline -- --dry-run   # list the stages; touch no network
//
// Exit codes: 0 ok / dry-run · 1 a gate was rejected or the runner stopped
//   unexpectedly · 2 setup error

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { argv, exit } from 'node:process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);
const FIXTURES = join(REPO, 'examples', 'demo-run');
const RUNNER = join(SCRIPT_DIR, 'run-pipeline.js');
const SERVE = join(FIXTURES, 'serve.js');
const PW_CONFIG = join(FIXTURES, 'playwright.demo.config.ts');
const DRY = argv.includes('--dry-run');

// The DEMO sentinel filename — metrics skips any run folder containing it.
export const DEMO_SENTINEL = 'DEMO_RUN';

// The stage plan. `copy` = fixture(s) to drop into the workspace BEFORE the
// runner advances to the matching step; the runner then stops at the next
// gate (interactive) or completes exec steps itself.
const STAGES = [
  { step: 'analyst', label: 'Analyst → context.json (replayed fixture)' },
  { step: 'gate1', label: 'GATE 1 — Requirement Interpretation (you decide)' },
  {
    step: 'test-designer',
    label: 'Test Designer → test-cases + planner brief',
  },
  { step: 'gate2', label: 'GATE 2 — Test Scope Approval (you decide)' },
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
  { step: 'classify', label: 'Classify → rule-based classifier (REAL)' },
  { step: 'report', label: 'Reporter → release report (replayed fixture)' },
  { step: 'done', label: 'Done → release report + BUG-001 draft' },
];

function printPlan() {
  console.log('Demo pipeline — stage plan (offline, deterministic):\n');
  for (const s of STAGES) console.log(`  ${s.step.padEnd(14)} ${s.label}`);
  console.log(
    '\nReplayed (fixtures): analyst, test-designer, planner, generator, report.'
  );
  console.log('Real: execute (Playwright), classify (rule-based classifier).');
  console.log('Interactive: the four gates — that is the point of the demo.');
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

// ---- 1. isolated workspace + DEMO sentinel ------------------------------
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const WORKSPACE = join(REPO, 'runs', 'DEMO-1', runId);
mkdirSync(WORKSPACE, { recursive: true });
writeFileSync(
  join(WORKSPACE, DEMO_SENTINEL),
  'This is a DEMO run (scripts/demo-pipeline.js). Metrics ignore it.\n'
);
cpSync(join(FIXTURES, 'story.md'), join(WORKSPACE, 'story.md'));

// ---- 2. serve the static app in a SEPARATE process ----------------------
// The driver advances the runner with spawnSync (synchronous, blocks this
// process's event loop). An in-process server would be unable to answer the
// browser while Playwright runs, so the server must be its own process. We
// read its ephemeral port from its first stdout line ("PORT <n>").
const serverProc = spawn('node', [SERVE], {
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
// Fixtures to copy into the workspace before a given step is reached, plus
// the artifact_paths the prefilled context must point at after the copy.
const FIXTURE_COPIES = {
  'test-designer': () => {
    cpDir('test-cases');
    cpDir('planner-input');
    setPaths({
      test_cases: 'test-cases/DEMO-1.json',
      planner_brief: 'planner-input/DEMO-1.planner-brief.md',
    });
  },
  planner: () => {
    cpDir('specs');
    setPaths({ playwright_spec: 'specs/DEMO-1.md' });
  },
  generator: () => {
    // The demo specs + config are referenced IN PLACE from examples/demo-run/
    // (never copied into the workspace tests/ — that folder is the Generator's
    // at the repo root, CLAUDE.md §3.2). We point artifact_paths at the
    // fixtures so the Gate-4 brief shows the file the human reviews.
    setPaths({
      generated_test: relFixture('tests/demo-broken.spec.ts'),
    });
  },
  report: () => {
    cpDir('release');
    setPaths({
      release_report_json: 'release/release-report.json',
      release_report_md: 'release/release-report.json',
      bug_drafts_dir: 'release/bug-drafts',
    });
  },
};

function cpDir(name) {
  cpSync(join(FIXTURES, name), join(WORKSPACE, name), { recursive: true });
}
function cpFile(name) {
  cpSync(join(FIXTURES, name), join(WORKSPACE, name));
}
// Path to a fixture file expressed RELATIVE to the workspace, so the gate
// brief (which checks existsSync from cwd=WORKSPACE) resolves it. Forward
// slashes for cross-platform context.json convention.
function relFixture(name) {
  return relative(WORKSPACE, join(FIXTURES, name)).split(sep).join('/');
}
function setPaths(patch) {
  const p = join(WORKSPACE, 'context.json');
  const ctx = JSON.parse(readFileSync(p, 'utf8'));
  Object.assign(ctx.artifact_paths, patch);
  writeFileSync(p, JSON.stringify(ctx, null, 2) + '\n');
}

function runnerStatus() {
  const r = spawnSync('node', [RUNNER, '--status'], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    env: { ...process.env, BASE_URL: baseURL },
  });
  const m = (r.stdout || '').match(/Next step:\s*(\S+)/);
  return m ? m[1] : null;
}

function advanceRunner() {
  // Interactive: gates inherit our stdin (the human decides); exec steps run.
  const r = spawnSync('node', [RUNNER, '--resume'], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE_URL: baseURL,
      PIPELINE_PW_CONFIG: PW_CONFIG,
    },
  });
  return r.status;
}

try {
  // Stage 0: replay the analyst output (context.json) into the workspace.
  cpFile('context.after-analyst.json');
  cpSync(
    join(WORKSPACE, 'context.after-analyst.json'),
    join(WORKSPACE, 'context.json')
  );
  rmSync(join(WORKSPACE, 'context.after-analyst.json'));

  let guard = 0;
  for (;;) {
    if (guard++ > 50) {
      console.error('Demo did not converge (too many steps) — aborting.');
      exit(2);
    }
    const step = runnerStatus();
    if (!step) {
      console.error('Could not read runner status — aborting.');
      exit(2);
    }
    if (step === 'done') {
      // One final --resume so the runner prints its completion message.
      advanceRunner();
      break;
    }
    // Before a guide step that needs fixtures, copy them in.
    if (FIXTURE_COPIES[step]) FIXTURE_COPIES[step]();

    const code = advanceRunner();
    // A guide step exits 0 after printing its instruction; a rejected gate
    // exits 1. In the demo the fixtures satisfy each guide step, so a non-zero
    // here means a gate was rejected (legitimate — the human said no).
    if (code === 1 && isGate(step)) {
      console.log(
        '\nA gate was rejected — the demo stops here (as it should).'
      );
      console.log(`Workspace kept at runs/DEMO-1/${runId}/ for inspection.`);
      cleanup();
      exit(1);
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('Demo complete. What just happened, end to end:');
  console.log('  - Four human gates, each recorded with opened_at/decided_at.');
  console.log('  - A REAL Playwright run against the local app.');
  console.log('  - The planted AC-2 bug became FAIL-001 -> product_bug (red)');
  console.log('    -> release/bug-drafts/BUG-001.md -> release report (fail).');
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

function isGate(step) {
  return ['gate1', 'gate2', 'gate3', 'gate4'].includes(step);
}
