#!/usr/bin/env node
// TestLink execution-result sync (Phase 2 TG10). For each test case that
// has a testlink_id, derive its run outcome and report that result against
// the TestLink test plan via XML-RPC (tl.reportTCResult). Dry-run by
// default; --apply-testlink-execution performs the real writes.
//
// This is the Reporter's optional downstream step. It is a SEPARATE script
// from scripts/sync-to-testlink.js (which creates the cases) because it has
// different inputs (failure-analysis), a different gate (Gate 4, code
// reviewed), and a different TestLink call (reportTCResult vs createTestCase).
//
// Outcome -> TestLink status comes from config/testlink-status-map.json
// (never hardcoded). The outcome for a case is:
//   - the classification of its failure in analysis/failure-analysis.json
//     (matched by test_case_id), if it failed;
//   - "skipped" if the case ran but was skipped;
//   - "passed" otherwise (has a testlink_id, no failure entry).
//
// Usage:
//   node scripts/sync-testlink-execution.js <story-id>                          # dry-run
//   node scripts/sync-testlink-execution.js <story-id> --apply-testlink-execution
//
// Env (from .env or process.env): TESTLINK_URL, TESTLINK_API_KEY,
//   TESTLINK_PROJECT_KEY, TESTLINK_TEST_PLAN_ID (required for the apply path).
//
// Exit codes: 0 ok · 1 sync/gate error · 2 usage/file/env error

import { readFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

// --- tiny .env loader (CI injects env directly; this only fills gaps) ----
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const APPLY = argv.includes('--apply-testlink-execution');
const storyId = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!storyId) {
  console.error(
    'Usage: node scripts/sync-testlink-execution.js <story-id> [--apply-testlink-execution]'
  );
  exit(2);
}

const casesPath = `test-cases/${storyId}.json`;
const mapPath = 'config/testlink-status-map.json';
const faPath = 'analysis/failure-analysis.json';

for (const [label, p] of [
  ['test-cases', casesPath],
  ['status map', mapPath],
  ['context.json', 'context.json'],
  ['failure-analysis', faPath],
]) {
  if (!existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    exit(2);
  }
}

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const context = loadJson('context.json');
const doc = loadJson(casesPath);
const map = loadJson(mapPath);
const fa = loadJson(faPath);

// --- Gate 4 precondition (same rule as the Failure Classifier/Reporter) --
const gate = context.review_gates?.code_reviewed;
const gateOk = gate === true || (gate && gate.status === true);
if (!gateOk) {
  console.error(
    'Gate 4 (code_reviewed) is not passed; refusing to sync execution results. ' +
      'Execution sync runs only after code review, like the Reporter.'
  );
  exit(1);
}

// --- Build TC -> outcome -------------------------------------------------
const statusByOutcome = map.outcome_to_testlink_status || {};
const defaultStatus = map.default_status || 'Blocked';
const statusCodes = map.testlink_statuses || {
  Pass: 'p',
  Fail: 'f',
  Blocked: 'b',
  'Not Run': 'n',
};

// Index failures by their originating test_case_id.
const failureByTc = new Map();
for (const f of fa.failures || []) {
  if (f.test_case_id) failureByTc.set(f.test_case_id, f);
}

// Only cases that were actually pushed to TestLink (have a testlink_id) can
// have a result reported.
const synced = (doc.test_cases || []).filter((tc) => tc.testlink_id);
const notSynced = (doc.test_cases || []).filter((tc) => !tc.testlink_id);

if (synced.length === 0) {
  console.log(
    `No test cases in ${casesPath} have a testlink_id. Run scripts/sync-to-testlink.js ` +
      `--apply-testlink first. Nothing to report.`
  );
  exit(0);
}

function outcomeFor(tc) {
  const f = failureByTc.get(tc.test_case_id);
  if (f) return f.classification || 'unknown_needs_human_review';
  if (tc.status === 'skip') return 'skipped';
  return 'passed';
}

const planned = synced.map((tc) => {
  const outcome = outcomeFor(tc);
  const tlStatus = statusByOutcome[outcome] || defaultStatus;
  return {
    ref: tc,
    test_case_id: tc.test_case_id,
    testlink_id: tc.testlink_id,
    outcome,
    tlStatus,
    code: statusCodes[tlStatus] || 'b',
  };
});

// --- Report the plan -----------------------------------------------------
console.log(`TestLink execution-result sync plan for ${storyId}`);
console.log(`  Project: ${env.TESTLINK_PROJECT_KEY ?? '(unset)'}`);
console.log(`  Test plan id: ${env.TESTLINK_TEST_PLAN_ID ?? '(unset)'}`);
console.log(`  Cases with a testlink_id: ${synced.length}`);
console.log(`  Cases without (skipped from result sync): ${notSynced.length}`);
for (const p of planned) {
  console.log(
    `    - ${p.test_case_id} (TestLink ${p.testlink_id}): outcome=${p.outcome} -> ${p.tlStatus} (${p.code})`
  );
}

if (!APPLY) {
  console.log(
    '\nDRY RUN (no writes). Re-run with --apply-testlink-execution to report to TestLink.'
  );
  exit(0);
}

// --- Apply path: real TestLink XML-RPC reportTCResult --------------------
const url = env.TESTLINK_URL;
const apiKey = env.TESTLINK_API_KEY;
const planId = env.TESTLINK_TEST_PLAN_ID;
if (!url || !apiKey || !planId) {
  console.error(
    'Apply requires TESTLINK_URL, TESTLINK_API_KEY, and TESTLINK_TEST_PLAN_ID.'
  );
  exit(2);
}

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
async function tl(method, struct) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, struct),
  });
  const text = await res.text();
  if (!res.ok && !text.includes('methodResponse')) {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  return text;
}

async function main() {
  let reported = 0;
  for (const p of planned) {
    // reportTCResult identifies the case by its external id (testcaseexternalid)
    // OR internal id (testcaseid); we stored TestLink's internal id as
    // testlink_id, so use testcaseid. status is the single-letter code.
    const xml = await tl('tl.reportTCResult', {
      devKey: apiKey,
      testcaseid: Number(p.testlink_id),
      testplanid: Number(planId),
      status: p.code,
      notes: `Auto-reported by scripts/sync-testlink-execution.js (outcome: ${p.outcome})`,
    });
    const fault = readFault(xml);
    if (fault) {
      throw new Error(`reportTCResult ${p.test_case_id}: ${fault}`);
    }
    reported += 1;
    console.log(`  ${p.test_case_id} -> ${p.tlStatus} reported`);
  }
  console.log(`\nDone. Reported ${reported} execution result(s) to TestLink.`);
}

main().catch((e) => {
  console.error(`\nTestLink execution sync FAILED: ${e.message}`);
  exit(1);
});
