#!/usr/bin/env node
// Mode-B story fetch helper (Phase 2 TG9/TG13). Fetches a Jira issue
// READ-ONLY and writes a local story.md the Analyst then reads. This is the
// reproducible "write a local copy of the issue text" step the Analyst's
// Mode B describes (agents/analyst.md §2) — pulled into a script so the
// vertical slice does not depend on hand-copying ACs out of Jira.
//
// READ ONLY. It never writes to Jira. The optional "pipeline started"
// comment is a separate, explicitly-approved action (not done here).
//
// It uses the Jira REST API directly (same credentials the atlassian MCP
// uses), because a plain Node script can't reach the MCP and this must also
// work in a no-agent context. It reads the READ-ONLY token; no write scope
// is needed or used.
//
// Usage:
//   node scripts/fetch-jira-story.js SK-10
//   node scripts/fetch-jira-story.js SK-10 --out story.md   # default: story.md
//   node scripts/fetch-jira-story.js SK-10 --print          # print, do not write
//
// Env (from .env or process.env): JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN.
//
// Exit codes: 0 ok · 1 fetch error · 2 usage/env error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const PRINT = argv.includes('--print');
const outIdx = argv.indexOf('--out');
const outPath =
  outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : 'story.md';
const key = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

if (!key) {
  console.error(
    'Usage: node scripts/fetch-jira-story.js <ISSUE-KEY> [--out story.md] [--print]'
  );
  exit(2);
}

const url = (env.JIRA_URL || '').replace(/\/$/, '');
const user = env.JIRA_USERNAME;
const token = env.JIRA_API_TOKEN;
if (!url || !user || !token) {
  console.error('Requires JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN in .env.');
  exit(2);
}
const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

// Flatten Atlassian Document Format to plain text, preserving paragraph and
// list-item line breaks so acceptance criteria stay readable.
function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = Array.isArray(node.content)
    ? node.content.map(adfToText).join('')
    : '';
  switch (node.type) {
    case 'paragraph':
      return inner + '\n\n';
    case 'listItem':
      return '- ' + inner.trim() + '\n';
    case 'bulletList':
    case 'orderedList':
      return inner;
    case 'heading':
      return '#'.repeat(node.attrs?.level || 2) + ' ' + inner.trim() + '\n\n';
    default:
      return inner;
  }
}

async function main() {
  const res = await fetch(
    `${url}/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,labels,components`,
    { headers: { Authorization: auth, Accept: 'application/json' } }
  );
  if (!res.ok) {
    const t = await res.text();
    console.error(
      `Fetch ${key} failed (HTTP ${res.status}): ${t.slice(0, 300)}`
    );
    exit(1);
  }
  const issue = await res.json();
  const f = issue.fields || {};
  const desc =
    adfToText(f.description).trim() || '(no description in the issue)';
  const components =
    (f.components || []).map((c) => c.name).join(', ') || '(none)';

  const md = [
    `# ${issue.key} — ${f.summary}`,
    '',
    `> Jira-mode story fetched READ-ONLY by scripts/fetch-jira-story.js for the`,
    `> Phase 2 vertical slice. The Analyst treats this as source: "jira",`,
    `> story.id = "${issue.key}", story.jira_issue_key = "${issue.key}".`,
    '',
    `**Issue type:** ${f.issuetype?.name ?? '?'}  ·  **Status:** ${f.status?.name ?? '?'}  ·  **Component:** ${components}`,
    '',
    '## Description / Acceptance criteria (verbatim from Jira)',
    '',
    desc,
    '',
    '## Notes for the QA pipeline',
    '',
    '- The Analyst must extract the acceptance criteria VERBATIM from the',
    '  text above and list any ambiguities — do not invent ACs.',
    '- If the issue text is thin, that is itself a Gate-1 ambiguity to flag.',
  ].join('\n');

  if (PRINT) {
    console.log(md);
    exit(0);
  }
  writeFileSync(outPath, md + '\n');
  console.log(
    `Wrote ${outPath} from ${issue.key} (read-only fetch; Jira not modified).`
  );
  console.log(
    'Next: run the Analyst on this story.md (Mode B) to produce context.json.'
  );
}

main().catch((e) => {
  console.error(`fetch-jira-story FAILED: ${e.message}`);
  exit(1);
});
