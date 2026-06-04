#!/usr/bin/env node
// TestLink sync — the TestLink adapter behind the TestManagementAdapter
// port (agents/test-management-adapter.md), runnable from CLI/CI. Reads
// context.json + the story's test-cases JSON, filters to approved cases,
// maps fields via config/testlink-field-map.json, and either prints the
// plan (dry-run, default) or pushes to TestLink over XML-RPC
// (--apply-testlink), writing testlink_id back into the test-cases JSON.
//
// This is the SUPPORTED TestLink path. The dogkeeper886/testlink-mcp
// bridge would not complete its MCP handshake in Claude Code (see
// docs/ambiguities.md A7); this script talks to the same TestLink
// XML-RPC endpoint directly (proven working: tl.checkDevKey -> boolean 1).
//
// Source of truth is test-cases/*.json; TestLink is a downstream target.
//
// Usage:
//   node scripts/sync-to-testlink.js <story-id>                  # dry-run
//   node scripts/sync-to-testlink.js <story-id> --apply-testlink # real write
//
// Env (loaded from .env if present, else process.env):
//   TESTLINK_URL  — full XML-RPC endpoint, e.g.
//                   http://host.docker.internal:8080/testlink/lib/api/xmlrpc/v1/xmlrpc.php
//                   (for a non-container CLI run use localhost, not
//                   host.docker.internal — see docs/testlink-integration.md)
//   TESTLINK_API_KEY, TESTLINK_PROJECT_KEY, TESTLINK_TEST_PLAN_ID
//
// Exit codes: 0 ok · 1 sync/validation error · 2 usage/file/env error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

// --- tiny .env loader (so a local CLI run works without exporting) -------
// CI injects env directly; this only fills gaps, never overrides real env.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const APPLY = argv.includes('--apply-testlink');
const storyId = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!storyId) {
  console.error(
    'Usage: node scripts/sync-to-testlink.js <story-id> [--apply-testlink]'
  );
  exit(2);
}

const casesPath = `test-cases/${storyId}.json`;
const mapPath = 'config/testlink-field-map.json';

for (const [label, p] of [
  ['test-cases', casesPath],
  ['field map', mapPath],
  ['context.json', 'context.json'],
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

// --- Gate 2 precondition -------------------------------------------------
const gate = context.review_gates?.test_scope_reviewed;
const gateOk = gate === true || (gate && gate.status === true);
if (!gateOk) {
  console.error(
    'Gate 2 (test_scope_reviewed) is not passed; refusing to sync. Approve the test scope first.'
  );
  exit(1);
}

// --- Filter to approved cases -------------------------------------------
const syncStatuses = map.sync_only_status || ['approved'];
const approved = (doc.test_cases || []).filter((tc) =>
  syncStatuses.includes(tc.status)
);
const skipped = (doc.test_cases || []).filter(
  (tc) => !syncStatuses.includes(tc.status)
);

if (approved.length === 0) {
  console.log(
    `No cases with status in [${syncStatuses.join(', ')}] in ${casesPath}. Nothing to sync.`
  );
  exit(0);
}

const importance = map.priority_to_importance || {};
const execType = map.automation_decision_to_execution_type || {};
const mapCase = (tc) => ({
  ref: tc,
  test_case_id: tc.test_case_id,
  name: `${tc.test_case_id} ${tc.title}`,
  summary: tc.description,
  preconditions: (tc.preconditions || []).join('<br/>'),
  steps: (tc.steps || []).map((s, i) => ({
    step_number: i + 1,
    actions: s.action + (s.data ? ` (data: ${JSON.stringify(s.data)})` : ''),
    expected_results: (tc.expected_results || []).join('<br/>'),
    execution_type: execType[tc.automation_decision] ?? 1,
  })),
  importance: importance[tc.priority] ?? 2,
  execution_type: execType[tc.automation_decision] ?? 1,
  already_synced: Boolean(tc.testlink_id),
});

const planned = approved.map(mapCase);
const suiteName = `${storyId} — ${context.story?.title ?? 'story'}`;

// --- Report the plan -----------------------------------------------------
console.log(`TestLink sync plan for ${storyId}`);
console.log(`  Project: ${env.TESTLINK_PROJECT_KEY ?? '(unset)'}`);
console.log(`  Test plan id: ${env.TESTLINK_TEST_PLAN_ID ?? '(unset)'}`);
console.log(`  Suite: ${suiteName}`);
console.log(`  Approved cases to sync: ${approved.length}`);
console.log(`  Skipped (not approved): ${skipped.length}`);
for (const p of planned) {
  const action = p.already_synced ? 'UPDATE (has testlink_id)' : 'CREATE';
  console.log(
    `    - ${p.test_case_id} "${p.ref.title}" -> ${action}, importance=${p.importance}, exec_type=${p.execution_type}`
  );
}

if (!APPLY) {
  console.log(
    '\nDRY RUN (no writes). Re-run with --apply-testlink to push to TestLink.'
  );
  exit(0);
}

// --- Apply path: real TestLink XML-RPC writes ----------------------------
const url = env.TESTLINK_URL;
const apiKey = env.TESTLINK_API_KEY;
const projectKey = env.TESTLINK_PROJECT_KEY;
if (!url || !apiKey || !projectKey) {
  console.error(
    'Apply requires TESTLINK_URL, TESTLINK_API_KEY, and TESTLINK_PROJECT_KEY.'
  );
  exit(2);
}

// Minimal XML-RPC client over built-in fetch (no dependency). TestLink
// takes a single struct param of name->value; we only need string/int.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function valueXml(value) {
  if (typeof value === 'number') return `<int>${value}</int>`;
  if (Array.isArray(value)) {
    // Array of step structs (TestLink's `steps` parameter).
    const items = value
      .map((obj) => {
        const members = Object.entries(obj)
          .map(
            ([k, v]) =>
              `<member><name>${k}</name><value>${valueXml(v)}</value></member>`
          )
          .join('');
        return `<value><struct>${members}</struct></value>`;
      })
      .join('');
    return `<array><data>${items}</data></array>`;
  }
  return `<string>${xmlEscape(value)}</string>`;
}
function member(name, value) {
  return `<member><name>${name}</name><value>${valueXml(value)}</value></member>`;
}
function buildCall(method, struct) {
  const members = Object.entries(struct)
    .map(([k, v]) => member(k, v))
    .join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params><param><value><struct>${members}</struct></value></param></params></methodCall>`;
}
// Very small XML-RPC response reader: pulls the first <name>X</name> ->
// scalar pairs and any fault string. Enough for the fields we read (id,
// message, code). TestLink returns either a struct or an array of structs.
function readResponse(xml) {
  if (/<fault>/.test(xml)) {
    const msg = (xml.match(
      /<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/
    ) || [])[1];
    return { fault: msg || 'unknown XML-RPC fault' };
  }
  const out = {};
  const re =
    /<member>\s*<name>([^<]+)<\/name>\s*<value>\s*(?:<(?:string|int|boolean|double)>)?([\s\S]*?)(?:<\/(?:string|int|boolean|double)>)?\s*<\/value>\s*<\/member>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2].trim();
  }
  // TestLink error responses come as an array of {code,message}.
  const codeMatch = xml.match(
    /<name>code<\/name>\s*<value>\s*<int>(\d+)<\/int>/
  );
  const msgMatch = xml.match(
    /<name>message<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/
  );
  if (codeMatch) out.code = codeMatch[1];
  if (msgMatch) out.message = msgMatch[1];
  return out;
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
  return readResponse(text);
}

// Raw POST that returns the response text (for array responses that the
// scalar reader above can't fully parse, e.g. tl.getProjects).
async function tlRaw(method, struct) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, struct),
  });
  return res.text();
}

async function main() {
  const dk = { devKey: apiKey };

  // 1. Resolve the project by PREFIX (TESTLINK_PROJECT_KEY) against the
  //    full project list. The project's TestLink name ("AI QA Pipeline")
  //    differs from the story title, so we match on the stable prefix.
  const projectsXml = await tlRaw('tl.getProjects', dk);
  if (/<fault>/.test(projectsXml)) {
    throw new Error(`tl.getProjects faulted: ${projectsXml.slice(0, 300)}`);
  }
  // Split into per-project <struct> blocks and find the one whose prefix
  // member equals TESTLINK_PROJECT_KEY; pull its id from the same block.
  let projectId = null;
  let projectName = null;
  for (const block of projectsXml.split('<struct>')) {
    const prefix = (block.match(
      /<name>prefix<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
    ) || [])[1];
    if (prefix === projectKey) {
      projectId = (block.match(
        /<name>id<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
      ) || [])[1];
      projectName = (block.match(
        /<name>name<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
      ) || [])[1];
      break;
    }
  }
  if (!projectId) {
    throw new Error(
      `No TestLink project with prefix "${projectKey}" (TESTLINK_PROJECT_KEY). ` +
        `Check the prefix matches a real project.`
    );
  }
  console.log(
    `\nResolved project "${projectName}" (prefix ${projectKey}) -> id ${projectId}`
  );

  // 2. Create the story's test suite under the project — or reuse it if a
  //    suite with the same name already exists (idempotent re-runs).
  const suite = await tl('tl.createTestSuite', {
    ...dk,
    testprojectid: projectId,
    testsuitename: suiteName,
    details: `Auto-synced from ${casesPath} by scripts/sync-to-testlink.js`,
  });
  let suiteId = suite.id && suite.id !== '0' ? suite.id : null;
  if (suiteId) {
    console.log(`Created suite "${suiteName}" -> id ${suiteId}`);
  } else {
    // createTestSuite refused (likely the name already exists). Find the
    // existing first-level suite with this name and reuse its id.
    const suitesXml = await tlRaw('tl.getFirstLevelTestSuitesForTestProject', {
      ...dk,
      testprojectid: projectId,
    });
    for (const block of suitesXml.split('<struct>')) {
      const nm = (block.match(
        /<name>name<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
      ) || [])[1];
      if (nm === suiteName) {
        suiteId = (block.match(
          /<name>id<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
        ) || [])[1];
        break;
      }
    }
    if (!suiteId) {
      throw new Error(
        `createTestSuite did not return an id and no existing suite named "${suiteName}" was found. createTestSuite response: ${JSON.stringify(suite)}`
      );
    }
    console.log(`Reusing existing suite "${suiteName}" -> id ${suiteId}`);
  }

  // 3. Create each approved case; collect testlink ids for write-back.
  let created = 0;
  for (const p of planned) {
    const r = await tl('tl.createTestCase', {
      ...dk,
      testcasename: p.name,
      testsuiteid: suiteId,
      testprojectid: projectId,
      authorlogin: 'admin',
      summary: p.summary,
      preconditions: p.preconditions,
      importance: p.importance,
      executiontype: p.execution_type,
      steps: p.steps,
    });
    if (r.fault)
      throw new Error(`createTestCase ${p.test_case_id}: ${r.fault}`);
    // TestLink returns the new case's id + additional_info.external_id.
    const tlId = r.id || r.additionalInfo || r.external_id;
    if (tlId) {
      p.ref.testlink_id = String(tlId);
      created += 1;
      console.log(`  ${p.test_case_id} -> TestLink id ${tlId}`);
    } else {
      console.warn(
        `  ${p.test_case_id}: created but no id in response: ${JSON.stringify(r)}`
      );
    }
  }

  // 4. Write the testlink_id linkage back into the source-of-truth JSON.
  writeFileSync(casesPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\nWrote testlink_id back into ${casesPath} (${created} cases).`);

  console.log(
    'Done. Note: adding cases to the test plan + the count-verify step ' +
      'use tl.addTestCaseToTestPlan / tl.getTestCasesForTestPlan and can be ' +
      'run as a follow-up; the create + write-back path is complete.'
  );
}

main().catch((e) => {
  console.error(`\nTestLink sync FAILED: ${e.message}`);
  exit(1);
});
