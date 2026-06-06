#!/usr/bin/env node
// Jira export helper (Phase 2.6 TG2.6-2, TG14 Option A). Turns a story's
// local test cases into Jira-ready output — either a CSV for Jira's bulk
// importer, or Markdown/wiki text to paste into a Jira description. The
// human pastes/imports; this script NEVER writes to Jira (zero write-risk
// to the shared board). For automated creation behind the
// TestManagementAdapter port, see scripts/create-jira-testcases.js (TG2.6-3).
//
// Source of truth stays test-cases/<story-id>.json; this is a one-way export.
//
// Usage:
//   node scripts/export-to-jira.js <story-id>                       # markdown to stdout (default)
//   node scripts/export-to-jira.js <story-id> --format csv          # CSV to stdout
//   node scripts/export-to-jira.js <story-id> --out out.csv         # write to a file
//   node scripts/export-to-jira.js <story-id> --include-risks       # also list context risks
//   node scripts/export-to-jira.js <story-id> --approved-only       # only status=approved TCs
//
// Env (from .env or process.env, optional): JIRA_PROJECT_KEY (prefills the
// CSV "Project Key" column), JIRA_TESTCASE_ISSUETYPE (default "Test").
//
// Exit codes: 0 ok · 2 usage/file error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const FORMAT = (() => {
  const i = argv.indexOf('--format');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : 'markdown';
})();
const OUT = (() => {
  const i = argv.indexOf('--out');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
})();
const INCLUDE_RISKS = argv.includes('--include-risks');
const APPROVED_ONLY = argv.includes('--approved-only');
const storyId = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!storyId) {
  console.error(
    'Usage: node scripts/export-to-jira.js <story-id> [--format markdown|csv] [--out file] [--include-risks] [--approved-only]'
  );
  exit(2);
}
if (!['markdown', 'csv'].includes(FORMAT)) {
  console.error(`Unknown --format "${FORMAT}". Use "markdown" or "csv".`);
  exit(2);
}

const casesPath = `test-cases/${storyId}.json`;
if (!existsSync(casesPath)) {
  console.error(`Test cases not found: ${casesPath}`);
  exit(2);
}

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const doc = loadJson(casesPath);
const context = existsSync('context.json') ? loadJson('context.json') : null;

const projectKey = env.JIRA_PROJECT_KEY || '';
const issueType = env.JIRA_TESTCASE_ISSUETYPE || 'Test';

let cases = doc.test_cases || [];
if (APPROVED_ONLY) cases = cases.filter((tc) => tc.status === 'approved');
if (cases.length === 0) {
  console.error(
    `No test cases${APPROVED_ONLY ? ' with status=approved' : ''} in ${casesPath}.`
  );
  exit(2);
}

// Build a plain-text description for one test case (used by both formats).
function describe(tc) {
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

function buildMarkdown() {
  const out = [`# Jira export — ${doc.story_id} test cases`, ''];
  out.push(
    `Paste each block into a Jira issue (type: ${issueType}). Source: ${casesPath}. This is a one-way export; Jira is not modified.`,
    ''
  );
  if (INCLUDE_RISKS && context?.risks?.length) {
    out.push('## Risks (context)', '');
    context.risks.forEach((r) =>
      out.push(`- **${r.risk_id}** (${r.severity}): ${r.description}`)
    );
    out.push('');
  }
  for (const tc of cases) {
    out.push(`## ${tc.test_case_id} — ${tc.title}`);
    out.push(`**Priority:** ${tc.priority}  ·  **Status:** ${tc.status}`);
    out.push('');
    out.push(describe(tc));
    out.push('', '---', '');
  }
  return out.join('\n');
}

// Minimal RFC-4180-ish CSV quoting.
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  // Columns chosen to match Jira's CSV importer mapping UI. "Project Key"
  // is prefilled from JIRA_PROJECT_KEY when set; the importer lets the human
  // remap any column.
  const header = [
    'Project Key',
    'Issue Type',
    'Summary',
    'Description',
    'Priority',
    'Labels',
  ];
  const rows = [header.map(csvCell).join(',')];
  for (const tc of cases) {
    rows.push(
      [
        projectKey,
        issueType,
        `${tc.test_case_id} ${tc.title}`,
        describe(tc),
        tc.priority,
        `${doc.story_id} ${tc.test_case_id} ${(tc.risk_ids || []).join(' ')}`,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return rows.join('\n') + '\n';
}

const output = FORMAT === 'csv' ? buildCsv() : buildMarkdown();

if (OUT) {
  writeFileSync(OUT, output);
  console.error(
    `Wrote ${cases.length} test case(s) as ${FORMAT} to ${OUT}. Jira was not modified.`
  );
} else {
  process.stdout.write(output);
}
exit(0);
