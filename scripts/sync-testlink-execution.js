#!/usr/bin/env node
// TestLink execution-result sync (Phase 2 TG10, rebuilt in task group 5.3).
// For each approved test case already in TestLink, derive ONE outcome from the
// current run's execution ledger and report it against the TestLink test plan
// (tl.reportTCResult). Dry-run by default; --apply-testlink-execution writes.
//
// Evidence, not absence (review finding I1). A case is reported:
//   Pass    only when every unit linked to it in the ledger explicitly passed;
//   Fail    only for a failure the FINALIZED failure analysis confirms as a
//           product bug on one of its units;
//   Blocked for any other failure, block, flake, expected failure, partial
//           execution, evidence from an unclean execution, or an unattributed
//           failing unit that might be its own;
//   Not Run when it is intentionally skipped, manual, or nothing ran for it.
// The rules live in scripts/lib/execution-ledger.js (testCaseOutcome). The
// outcome -> TestLink status mapping lives in config/testlink-status-map.json.
//
// The ledger must be valid and belong to this story, this run and this
// approved scope (its approved_scope_digest). An apply without such a ledger
// is refused; a dry run shows every case as Not Run and says why. API results
// are withheld until the API branch's own review gates exist. Nothing in the
// repository is written: reporting results never changes a source artifact.
//
// Usage:
//   node scripts/sync-testlink-execution.js <story-id>                          # dry-run
//   node scripts/sync-testlink-execution.js <story-id> --apply-testlink-execution
//
// Env (from .env or process.env): TEST_MANAGEMENT_TOOL (testlink | both),
//   TESTLINK_URL, TESTLINK_API_KEY, TESTLINK_TEST_PLAN_ID (required to apply),
//   QAIZEN_HTTP_TIMEOUT_MS (default 30000).
//
// Exit codes: 0 ok · 1 sync/gate/evidence error · 2 usage/file/env/config error

import { existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

import {
  readJson,
  readValidatedJson,
  formatErrors,
} from './lib/artifact-io.js';
import { requireCurrentGate } from './lib/approval-binding.js';
import {
  CASE_REPORT_OUTCOMES,
  approvedScopeDigest,
  readLedger,
  testCaseOutcome,
} from './lib/execution-ledger.js';
import {
  acquireLock,
  checkSyncScope,
  httpRequest,
  httpTimeoutMs,
  loadDotEnv,
  planOperation,
  sanitizeDiagnostic,
  selectTestManagementTarget,
} from './lib/integration-io.js';

const TARGET = 'testlink';
const CASES_SCHEMA = 'schemas/test-cases.schema.json';
const ANALYSIS_SCHEMA = 'schemas/failure-analysis.schema.json';
const LEDGER_PATH = 'analysis/execution-ledger.json';
const ANALYSIS_PATH = 'analysis/failure-analysis.json';
const TESTLINK_ID = /^[1-9][0-9]*$/;
const STATUS_CODES = new Set(['p', 'f', 'b', 'n']);

// ------------------------------------------------------------ XML-RPC

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function valueXml(value) {
  if (typeof value === 'number') return `<int>${value}</int>`;
  return `<string>${xmlEscape(value)}</string>`;
}
function buildCall(method, struct) {
  const members = Object.entries(struct)
    .map(
      ([k, v]) =>
        `<member><name>${k}</name><value>${valueXml(v)}</value></member>`
    )
    .join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params><param><value><struct>${members}</struct></value></param></params></methodCall>`;
}
function readFault(xml) {
  if (/<fault>/.test(xml)) {
    const msg = (xml.match(
      /<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/
    ) || [])[1];
    return msg || 'unknown XML-RPC fault';
  }
  // TestLink also returns {code,message} arrays on logical errors.
  const code = xml.match(/<name>code<\/name>\s*<value>\s*<int>(\d+)<\/int>/);
  if (code) {
    const msg = (xml.match(
      /<name>message<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/
    ) || [])[1];
    return `code ${code[1]}: ${msg || '(no message)'}`;
  }
  return null;
}

/**
 * The status map, checked: every report outcome maps to a named status with a
 * TestLink code, and ONLY `passed` may reach Pass.
 */
function loadStatusMap(map) {
  const byOutcome = map.outcome_to_testlink_status ?? {};
  const codes = map.testlink_statuses ?? {};
  const problems = [];
  const resolved = {};
  for (const outcome of CASE_REPORT_OUTCOMES) {
    const name = byOutcome[outcome];
    const code = typeof name === 'string' ? codes[name] : undefined;
    if (!name) problems.push(`no status for outcome "${outcome}"`);
    else if (!STATUS_CODES.has(code))
      problems.push(`status "${name}" has no TestLink code (p/f/b/n)`);
    else resolved[outcome] = { name, code };
  }
  for (const [outcome, s] of Object.entries(resolved)) {
    if (s.code === 'p' && outcome !== 'passed') {
      problems.push(`"${outcome}" must not map to a passing status`);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, resolved };
}

async function main() {
  loadDotEnv(env);

  const APPLY = argv.includes('--apply-testlink-execution');
  const storyId = argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  if (!storyId) {
    console.error(
      'Usage: node scripts/sync-testlink-execution.js <story-id> [--apply-testlink-execution]'
    );
    return 2;
  }

  const selected = selectTestManagementTarget(env.TEST_MANAGEMENT_TOOL, TARGET);
  if (!selected.ok) {
    console.error(selected.reason);
    return 2;
  }

  const casesPath = `test-cases/${storyId}.json`;
  const mapPath = 'config/testlink-status-map.json';
  for (const [label, p] of [
    ['test-cases', casesPath],
    ['status map', mapPath],
    ['context.json', 'context.json'],
  ]) {
    if (!existsSync(p)) {
      console.error(`Missing ${label}: ${p}`);
      return 2;
    }
  }

  // --- Inputs, identity and approvals ----------------------------------
  const docRead = readValidatedJson(casesPath, CASES_SCHEMA);
  if (!docRead.ok) {
    console.error(docRead.message);
    for (const line of formatErrors(docRead.errors)) console.error(line);
    return 2;
  }
  const doc = docRead.data;
  const ctxRead = readJson('context.json');
  const mapRead = readJson(mapPath);
  for (const r of [ctxRead, mapRead]) {
    if (!r.ok) {
      console.error(r.message);
      return 2;
    }
  }
  const context = ctxRead.data;
  const statusMap = loadStatusMap(mapRead.data);
  if (!statusMap.ok) {
    console.error(`${mapPath} is not usable:`);
    for (const p of statusMap.problems) console.error(`  - ${p}`);
    return 2;
  }

  const scope = checkSyncScope(context, doc, storyId, '.');
  if (!scope.ok) {
    console.error(`${scope.reason}. Refusing to sync execution results.`);
    return 1;
  }
  // The E2E branch review (Gate 4). An approval counts only while it still
  // matches what was reviewed (task group 4.3).
  const gate4 = requireCurrentGate(context, 'code_reviewed', '.');
  if (!gate4.ok) {
    console.error(
      `Gate 4: ${gate4.reason}. Refusing to sync execution results.`
    );
    return 1;
  }

  // --- The failure analysis: which failures are CONFIRMED product bugs --
  const confirmed = new Set();
  if (existsSync(ANALYSIS_PATH)) {
    const fa = readJson(ANALYSIS_PATH);
    if (!fa.ok) {
      console.error(fa.message);
      return 1;
    }
    const version = String(fa.data.schema_version ?? '');
    if (/^2\./.test(version)) {
      // A draft is the pre-classifier's first pass: publishing it would
      // report a guess as the verdict (task group 3.3).
      if (fa.data.status !== 'finalized') {
        console.error(
          `${ANALYSIS_PATH} is a ${fa.data.status || 'status-less'} ${version} analysis; refusing to sync ` +
            'execution results. Finalize it first (the Failure Classifier Agent or a human ' +
            'confirms classifications, writes bug drafts, then sets status "finalized").'
        );
        return 1;
      }
      const valid = readValidatedJson(ANALYSIS_PATH, ANALYSIS_SCHEMA);
      if (!valid.ok) {
        console.error(`${valid.message}. Refusing to sync execution results.`);
        return 1;
      }
      if (fa.data.story_id !== storyId || fa.data.run_id !== context.run_id) {
        console.error(
          `${ANALYSIS_PATH} belongs to story ${fa.data.story_id} / run ${fa.data.run_id}, ` +
            `not the active ${storyId} / ${context.run_id}. Refusing to sync execution results.`
        );
        return 1;
      }
      for (const f of fa.data.failures ?? []) {
        if (f.classification === 'product_bug' && f.unit_id) {
          confirmed.add(f.unit_id);
        }
      }
    } else {
      console.warn(
        `${ANALYSIS_PATH} is a ${version || 'version-less'} analysis without unit ids; ` +
          'no failure is treated as a confirmed product failure.'
      );
    }
  }

  // --- The ledger: this story, this run, this approved scope ------------
  let ledger = null;
  let ledgerProblem = null;
  if (!existsSync(LEDGER_PATH)) {
    ledgerProblem = `${LEDGER_PATH} does not exist (run npm run normalize, or the pipeline's classify step)`;
  } else {
    const read = readLedger(LEDGER_PATH, {
      storyId,
      runId: context.run_id,
    });
    if (!read.ok) {
      ledgerProblem = [read.message, ...(read.violations ?? [])].join('; ');
    } else if (read.data.approved_scope_digest === null) {
      ledgerProblem = `${LEDGER_PATH} does not record the approved scope it was built for; re-normalize with --test-cases ${casesPath}`;
    } else if (read.data.approved_scope_digest !== approvedScopeDigest(doc)) {
      ledgerProblem = `${LEDGER_PATH} was built for a different approved scope than ${casesPath} holds now`;
    } else {
      ledger = read.data;
    }
  }

  // --- Plan: one outcome per approved case already in TestLink ----------
  const approved = doc.test_cases.filter((tc) => tc.status === 'approved');
  const reportable = [];
  const notReported = [];
  for (const tc of approved) {
    const link = planOperation({
      record: tc.sync_state?.[TARGET],
      remoteIds: [tc.testlink_id, tc.external_ids?.[TARGET]],
      isValidId: (id) => TESTLINK_ID.test(id),
    });
    if (link.action !== 'skip') {
      notReported.push({
        tc,
        why:
          link.action === 'create'
            ? 'not in TestLink yet'
            : `its TestLink link is unresolved (${link.reason ?? link.action})`,
      });
      continue;
    }
    if (tc.automation_decision === 'automate_api') {
      notReported.push({
        tc,
        why: 'API results wait for the API branch review gates, which are not recorded yet',
      });
      continue;
    }
    // Skipped and manual cases are Not Run for their own reasons, with or
    // without a ledger. Anything else without valid evidence is Not Run
    // because of the missing evidence (and an apply is refused below).
    const ownReason = ['skip', 'manual'].includes(tc.automation_decision);
    let derived;
    if (ledger || ownReason) {
      derived = testCaseOutcome({
        testCase: tc,
        ledger: ledger ?? { units: [], source_executions: [] },
        confirmedProductFailureUnits: confirmed,
      });
    } else {
      derived = {
        outcome: 'not_run',
        reason: `no valid ledger: ${ledgerProblem}`,
        unitIds: [],
      };
    }
    reportable.push({
      tc,
      testlinkId: link.id,
      ...derived,
      status: statusMap.resolved[derived.outcome],
    });
  }

  console.log(`TestLink execution-result sync plan for ${storyId}`);
  console.log(`  Run: ${context.run_id}`);
  console.log(`  Test plan id: ${env.TESTLINK_TEST_PLAN_ID ?? '(unset)'}`);
  console.log(
    `  Evidence: ${ledger ? `${LEDGER_PATH} (${ledger.units.length} unit(s))` : `NONE — ${ledgerProblem}`}`
  );
  console.log(`  To report: ${reportable.length}`);
  for (const r of reportable) {
    console.log(
      `    - ${r.tc.test_case_id} (TestLink ${r.testlinkId}): ${r.outcome} -> ${r.status.name} (${r.status.code}) — ${r.reason}`
    );
  }
  if (notReported.length) {
    console.log(`  Not reported: ${notReported.length}`);
    for (const n of notReported) {
      console.log(`    - ${n.tc.test_case_id}: ${n.why}`);
    }
  }

  if (!APPLY) {
    console.log(
      '\nDRY RUN (no writes). Re-run with --apply-testlink-execution to report to TestLink.'
    );
    return 0;
  }

  // --- Apply ------------------------------------------------------------
  if (!ledger) {
    console.error(
      `\nRefusing to report results without valid execution evidence: ${ledgerProblem}.`
    );
    return 1;
  }
  if (!reportable.length) {
    console.log('\nNothing to report.');
    return 0;
  }
  const url = env.TESTLINK_URL;
  const apiKey = env.TESTLINK_API_KEY;
  const planId = env.TESTLINK_TEST_PLAN_ID;
  if (!url || !apiKey || !TESTLINK_ID.test(planId ?? '')) {
    console.error(
      'Apply requires TESTLINK_URL, TESTLINK_API_KEY, and a numeric TESTLINK_TEST_PLAN_ID.'
    );
    return 2;
  }
  let timeoutMs;
  try {
    timeoutMs = httpTimeoutMs(env);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const lock = acquireLock('.', TARGET);
  if (!lock.ok) {
    console.error(`Refusing to report: ${lock.reason}`);
    return 1;
  }
  try {
    let reported = 0;
    for (const r of reportable) {
      // testlink_id holds TestLink's internal id, so identify by testcaseid.
      const res = await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: buildCall('tl.reportTCResult', {
          devKey: apiKey,
          testcaseid: Number(r.testlinkId),
          testplanid: Number(planId),
          status: r.status.code,
          notes: `Qaizen run ${context.run_id}: ${r.outcome} — ${r.reason}`,
        }),
        timeoutMs,
      });
      const problem =
        res.kind !== 'response'
          ? `${res.error}; the result may or may not have been recorded`
          : !res.text.includes('methodResponse')
            ? `HTTP ${res.status}: ${sanitizeDiagnostic(res.text, [apiKey])}`
            : readFault(res.text);
      if (problem) {
        console.error(
          `reportTCResult ${r.tc.test_case_id}: ${sanitizeDiagnostic(problem, [apiKey])}\n` +
            `Reported ${reported} of ${reportable.length} before stopping.`
        );
        return 1;
      }
      reported += 1;
      console.log(`  ${r.tc.test_case_id} -> ${r.status.name} reported`);
    }
    console.log(
      `\nDone. Reported ${reported} execution result(s) to TestLink.`
    );
    return 0;
  } finally {
    lock.release();
  }
}

main().then(
  (code) => exit(code),
  (e) => {
    console.error(`\nTestLink execution sync FAILED: ${e.message}`);
    exit(1);
  }
);
