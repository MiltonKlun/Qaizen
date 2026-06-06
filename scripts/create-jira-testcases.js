#!/usr/bin/env node
// Jira test-case adapter (Phase 2.6 TG2.6-3, TG14 Option B). Creates a
// story's APPROVED test cases as ordinary Jira issues (no Xray app needed),
// links each to the story issue, and writes the new key back into
// test-cases/<story-id>.json under external_ids.jira. Dry-run by default;
// --apply performs the real writes.
//
// This is the JIRA implementation of the TestManagementAdapter port
// (agents/test-management-adapter.md). Source of truth stays
// test-cases/*.json; Jira is a downstream mirror selected by config. It is
// the sibling of scripts/sync-to-testlink.js (TestLink adapter) and is gated
// exactly like scripts/create-jira-bugs.js.
//
// Destination selection: this script only runs the Jira adapter. It refuses
// to run unless TEST_MANAGEMENT_TOOL includes "jira" (values: jira | both),
// so a repo configured for testlink/none won't write to Jira by accident.
//
// Talks to the Jira REST API directly (same approach as create-jira-bugs.js;
// the MCP isn't reachable from a plain Node script and CI has no agent).
//
// Usage:
//   node scripts/create-jira-testcases.js <story-id>            # dry-run (default)
//   node scripts/create-jira-testcases.js <story-id> --apply    # real Jira writes
//   node scripts/create-jira-testcases.js <story-id> --apply --limit 5
//
// Env (.env or process.env): TEST_MANAGEMENT_TOOL, JIRA_URL, JIRA_USERNAME,
//   JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_TESTCASE_ISSUETYPE (default Test).
//
// Exit codes: 0 ok · 1 sync/gate error · 2 usage/file/env/selection error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const APPLY = argv.includes('--apply');
const limitIdx = argv.indexOf('--limit');
const LIMIT =
  limitIdx !== -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : Infinity;
const storyId = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!storyId) {
  console.error(
    'Usage: node scripts/create-jira-testcases.js <story-id> [--apply] [--limit N]'
  );
  exit(2);
}

// --- Destination selection (the port's TEST_MANAGEMENT_TOOL) -------------
const tool = (env.TEST_MANAGEMENT_TOOL || '').toLowerCase();
if (!['jira', 'both'].includes(tool)) {
  console.error(
    `TEST_MANAGEMENT_TOOL is "${env.TEST_MANAGEMENT_TOOL || '(unset)'}"; the Jira ` +
      `adapter only runs when it is "jira" or "both". Set it to opt in.`
  );
  exit(2);
}

const casesPath = `test-cases/${storyId}.json`;
const mapPath = 'config/jira-testcase-map.json';
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

// --- Gate 2 precondition (same rule as the TestLink adapter) -------------
const gate = context.review_gates?.test_scope_reviewed;
const gateOk = gate === true || (gate && gate.status === true);
if (!gateOk) {
  console.error(
    'Gate 2 (test_scope_reviewed) is not passed; refusing to sync. Approve the test scope first.'
  );
  exit(1);
}

const writebackKey = map.writeback_key || 'jira';
const syncStatuses = map.sync_only_status || ['approved'];
const issueType =
  env[map.issue_type_env || 'JIRA_TESTCASE_ISSUETYPE'] ||
  map.default_issue_type ||
  'Test';
const priorityMap = map.priority_map || null;
const staticLabels = map.labels || [];
const linkType = map.link_type || 'Relates';

const storyKey = context.story?.jira_issue_key || null;
const projectKey = env.JIRA_PROJECT_KEY;

// --- Filter to approved + not-already-synced -----------------------------
const approved = (doc.test_cases || []).filter((tc) =>
  syncStatuses.includes(tc.status)
);
const already = [];
const toCreate = [];
for (const tc of approved) {
  const existing = tc.external_ids && tc.external_ids[writebackKey];
  if (existing) already.push({ tc, key: existing });
  else toCreate.push(tc);
}
const limited = toCreate.slice(0, LIMIT);

function summaryFor(tc) {
  return (map.summary_template || '{test_case_id} {title}')
    .replace('{test_case_id}', tc.test_case_id)
    .replace('{title}', tc.title);
}
function descriptionFor(tc) {
  const lines = [];
  if (tc.description) lines.push(tc.description, '');
  if (tc.preconditions?.length) {
    lines.push('Preconditions:');
    tc.preconditions.forEach((p) => lines.push(`- ${p}`));
    lines.push('');
  }
  if (tc.steps?.length) {
    lines.push('Steps:');
    tc.steps.forEach((s, i) => {
      const data =
        s.data !== undefined ? ` (data: ${JSON.stringify(s.data)})` : '';
      lines.push(`${i + 1}. ${s.action}${data}`);
    });
    lines.push('');
  }
  if (tc.expected_results?.length) {
    lines.push('Expected results:');
    tc.expected_results.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }
  lines.push(
    `Traceability: ${tc.test_case_id} | risks ${(tc.risk_ids || []).join(', ')} | story ${doc.story_id}`
  );
  return lines.join('\n').trim();
}

// --- Report the plan -----------------------------------------------------
console.log(
  `Jira test-case sync plan for ${storyId} (TEST_MANAGEMENT_TOOL=${tool})`
);
console.log(
  `  Project: ${projectKey ?? '(unset)'}  ·  Issue type: ${issueType}`
);
console.log(
  `  Story link: ${storyKey ? `${storyKey} (${linkType})` : '(no jira_issue_key — cases will not be linked)'}`
);
console.log(`  Approved cases: ${approved.length}`);
console.log(
  `  Already synced (skip, have external_ids.${writebackKey}): ${already.length}`
);
for (const a of already) console.log(`    - ${a.tc.test_case_id} -> ${a.key}`);
console.log(
  `  To create: ${limited.length}${toCreate.length > limited.length ? ` (of ${toCreate.length}; --limit ${LIMIT})` : ''}`
);
for (const tc of limited) {
  const pr = priorityMap
    ? ` -> priority ${priorityMap[tc.priority] || '(default)'}`
    : '';
  console.log(`    - ${tc.test_case_id} "${tc.title}"${pr}`);
}

if (limited.length === 0) {
  console.log('\nNothing to create.');
  exit(0);
}
if (!APPLY) {
  console.log(
    '\nDRY RUN (no Jira writes). Re-run with --apply to create these.'
  );
  exit(0);
}

// --- Apply path: real Jira REST writes -----------------------------------
const jiraUrl = (env.JIRA_URL || '').replace(/\/$/, '');
const user = env.JIRA_USERNAME;
const token = env.JIRA_API_TOKEN;
if (!jiraUrl || !user || !token || !projectKey) {
  console.error(
    'Apply requires JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, and JIRA_PROJECT_KEY.'
  );
  exit(2);
}
const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

function adf(text) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}
async function jira(path, method, body) {
  const res = await fetch(`${jiraUrl}${path}`, {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* empty/non-JSON */
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  let created = 0;
  for (const tc of limited) {
    const labels = [...staticLabels, doc.story_id, tc.test_case_id].map((l) =>
      String(l).replace(/\s+/g, '-')
    );
    const fields = {
      project: { key: projectKey },
      summary: summaryFor(tc).slice(0, 250),
      issuetype: { name: issueType },
      description: adf(descriptionFor(tc)),
      labels,
    };
    if (priorityMap && priorityMap[tc.priority]) {
      fields.priority = { name: priorityMap[tc.priority] };
    }

    let r = await jira('/rest/api/3/issue', 'POST', { fields });
    // Retry once without priority/labels if the project rejects them.
    if (!r.ok && /priority|labels/i.test(r.text)) {
      console.warn(
        `  ${tc.test_case_id}: project rejected priority/labels; retrying minimal.`
      );
      delete fields.priority;
      delete fields.labels;
      r = await jira('/rest/api/3/issue', 'POST', { fields });
    }
    if (!r.ok) {
      throw new Error(
        `${tc.test_case_id}: create failed (HTTP ${r.status}): ${r.text.slice(0, 400)}`
      );
    }
    const key = r.json.key;
    console.log(`  ${tc.test_case_id} -> created ${key}`);

    if (storyKey) {
      const lr = await jira('/rest/api/3/issueLink', 'POST', {
        type: { name: linkType },
        inwardIssue: { key },
        outwardIssue: { key: storyKey },
      });
      console.log(
        lr.ok
          ? `      linked ${key} --[${linkType}]--> ${storyKey}`
          : `      WARN: link ${key}->${storyKey} failed (HTTP ${lr.status}); issue created, link skipped.`
      );
    }

    // Write the key back into our source of truth under external_ids.
    tc.external_ids = tc.external_ids || {};
    tc.external_ids[writebackKey] = key;
    created += 1;
  }

  writeFileSync(casesPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(
    `\nDone. Created ${created} Jira issue(s); wrote external_ids.${writebackKey} back into ${casesPath}.`
  );
}

main().catch((e) => {
  console.error(`\nJira test-case sync FAILED: ${e.message}`);
  exit(1);
});
