#!/usr/bin/env node
// @ts-check
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
// Options may come before or after <story-id>. An unknown option, a missing
// value, or a repeated option is a usage error (scripts/lib/cli.js).
//
// Env (from .env or process.env, optional): JIRA_PROJECT_KEY (prefills the
// CSV "Project Key" column), JIRA_TESTCASE_ISSUETYPE (default "Test").
//
// Exit codes: 0 ok · 2 usage/file error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

import { loadDotEnv, parseCliOrExit, validateStoryId } from './lib/cli.js';

loadDotEnv(env);

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/export-to-jira.js <story-id> [--format markdown|csv] [--out file] [--include-risks] [--approved-only]\n' +
    '  Options may come before or after <story-id>.',
  positionals: [{ name: 'story-id', validate: validateStoryId }],
  options: {
    format: { type: 'string', choices: ['markdown', 'csv'] },
    out: { type: 'string' },
    'include-risks': { type: 'boolean' },
    'approved-only': { type: 'boolean' },
  },
});
const FORMAT = /** @type {string} */ (cli.values.format ?? 'markdown');
const OUT = /** @type {string | undefined} */ (cli.values.out) ?? null;
const INCLUDE_RISKS = cli.values['include-risks'] === true;
const APPROVED_ONLY = cli.values['approved-only'] === true;
const storyId = cli.positionals['story-id'];

const casesPath = `test-cases/${storyId}.json`;
if (!existsSync(casesPath)) {
  console.error(`Test cases not found: ${casesPath}`);
  exit(2);
}

/** @type {(p: string) => any} */
const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const doc = loadJson(casesPath);
const context = existsSync('context.json') ? loadJson('context.json') : null;

const projectKey = env.JIRA_PROJECT_KEY || '';
const issueType = env.JIRA_TESTCASE_ISSUETYPE || 'Test';

/** @type {import('./lib/execution-ledger.js').TestCase[]} */
let cases = doc.test_cases || [];
if (APPROVED_ONLY) cases = cases.filter((tc) => tc.status === 'approved');
if (cases.length === 0) {
  console.error(
    `No test cases${APPROVED_ONLY ? ' with status=approved' : ''} in ${casesPath}.`
  );
  exit(2);
}

// Build a plain-text description for one test case (used by both formats).
/** @param {import('./lib/execution-ledger.js').TestCase} tc */
function describe(tc) {
  /** @type {string[]} */
  const lines = [];
  if (tc.description) lines.push(tc.description, '');
  if (tc.preconditions?.length) {
    lines.push('Preconditions:');
    tc.preconditions.forEach((/** @type {string} */ p) => lines.push(`- ${p}`));
    lines.push('');
  }
  if (tc.steps?.length) {
    lines.push('Steps:');
    tc.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const data =
        s.data !== undefined ? ` (data: ${JSON.stringify(s.data)})` : '';
      lines.push(`${i + 1}. ${s.action}${data}`);
    });
    lines.push('');
  }
  if (tc.expected_results?.length) {
    lines.push('Expected results:');
    tc.expected_results.forEach((/** @type {string} */ e) =>
      lines.push(`- ${e}`)
    );
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
    context.risks.forEach((/** @type {Record<string, any>} */ r) =>
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
/** @param {unknown} v */
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
