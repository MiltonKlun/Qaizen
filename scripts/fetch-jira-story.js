#!/usr/bin/env node
// @ts-check
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
// The text is converted, not interpreted (scripts/lib/jira-story.js): the
// same issue always gives the same story.md, whose digest Gate 1 binds.
//
// Usage:
//   node scripts/fetch-jira-story.js SK-10
//   node scripts/fetch-jira-story.js SK-10 --out story.md   # default: story.md
//   node scripts/fetch-jira-story.js SK-10 --print          # print, do not write
//
// Options may come before or after the issue key. An unknown option, a
// missing value, or a repeated option is a usage error (scripts/lib/cli.js).
//
// Env (from the repository's .env or process.env): JIRA_URL, JIRA_USERNAME,
//   JIRA_API_TOKEN. Optional: JIRA_AC_FIELD, the id of a custom field that
//   holds acceptance criteria (e.g. customfield_10045), rendered in its own
//   section; JIRA_STORY_COMMENTS=true to add the issue's comments, marked as
//   context, never criteria.
//
// Exit codes: 0 ok · 1 fetch error · 2 usage/env error

import { writeFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

import { loadDotEnv, parseCliOrExit } from './lib/cli.js';
import { JIRA_KEY, repoFile } from './lib/integration-io.js';
import { storyMarkdown } from './lib/jira-story.js';

loadDotEnv(env, repoFile('.env'));

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/fetch-jira-story.js <ISSUE-KEY> [--out story.md] [--print]\n' +
    '  Options may come before or after <ISSUE-KEY>.',
  positionals: [
    {
      name: 'ISSUE-KEY',
      validate: (v) =>
        JIRA_KEY.test(v) ? null : `"${v}" is not a Jira issue key (e.g. SK-10)`,
    },
  ],
  options: { out: { type: 'string' }, print: { type: 'boolean' } },
  exclusive: [['out', 'print']],
});
const PRINT = cli.values.print === true;
const outPath =
  /** @type {string | undefined} */ (cli.values.out) ?? 'story.md';
const key = cli.positionals['ISSUE-KEY'];

const url = (env.JIRA_URL || '').replace(/\/$/, '');
const user = env.JIRA_USERNAME;
const token = env.JIRA_API_TOKEN;
if (!url || !user || !token) {
  console.error('Requires JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN in .env.');
  exit(2);
}
const acField = (env.JIRA_AC_FIELD || '').trim() || null;
if (acField && !/^customfield_\d+$/.test(acField)) {
  console.error(
    `JIRA_AC_FIELD is "${acField}"; it must be a custom field id such as customfield_10045.`
  );
  exit(2);
}
const comments = /^(1|true|yes)$/i.test(env.JIRA_STORY_COMMENTS || '');
const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

async function main() {
  const fields = [
    'summary',
    'description',
    'issuetype',
    'status',
    'priority',
    'labels',
    'components',
    'parent',
    'updated',
    ...(comments ? ['comment'] : []),
    ...(acField ? [acField] : []),
  ].join(',');
  const res = await fetch(`${url}/rest/api/3/issue/${key}?fields=${fields}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(
      `Fetch ${key} failed (HTTP ${res.status}): ${t.slice(0, 300)}`
    );
    exit(1);
  }
  const md = storyMarkdown(await res.json(), {
    browseUrl: `${url}/browse/${key}`,
    acField,
    comments,
  });

  if (PRINT) {
    process.stdout.write(md);
    exit(0);
  }
  writeFileSync(outPath, md);
  console.log(
    `Wrote ${outPath} from ${key} (read-only fetch; Jira not modified).`
  );
  console.log(
    'Next: run the Analyst on this story.md (Mode B) to produce context.json.'
  );
}

main().catch((e) => {
  console.error(`fetch-jira-story FAILED: ${e.message}`);
  exit(1);
});
