#!/usr/bin/env node
// Jira bug promotion — reads human-reviewed Red bug drafts from
// release/bug-drafts/BUG-*.md and (only with --apply) files them as Jira
// issues, links each to the story issue when context.story.jira_issue_key
// exists, and writes the new key back into the draft. Dry-run by default.
//
// This is the ONLY path that files a Jira bug, and only when a human types
// --apply (the "writes are never a side effect" rule, docs/mcp-setup.md).
// No agent creates issues on its own.
//
// It talks to the Jira REST API directly (same approach the codebase uses
// for TestLink XML-RPC in scripts/sync-to-testlink.js): the MCP isn't
// reachable from a plain Node script and CI has no agent. The credentials
// are exactly those the atlassian-write MCP uses.
//
// Usage:
//   node scripts/create-jira-bugs.js                 # dry-run (default)
//   node scripts/create-jira-bugs.js --apply         # real Jira writes
//   node scripts/create-jira-bugs.js --dir <path>    # override drafts dir
//
// Env (loaded from .env if present, else process.env):
//   JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN  — same as the read MCP
//   JIRA_PROJECT_KEY                          — target project (e.g. SK)
//   JIRA_BUG_ISSUETYPE                        — default "Bug"
//
// Config: config/jira-priority-map.json (severity -> priority, link type).
//
// Exit codes: 0 ok · 1 promotion/parse error · 2 usage/file/env error

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

// --- tiny .env loader (so a local CLI run works without exporting) -------
// CI injects env directly; this only fills gaps, never overrides real env.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

const APPLY = argv.includes('--apply');
const dirFlagIdx = argv.indexOf('--dir');
const draftsDir =
  dirFlagIdx !== -1 && argv[dirFlagIdx + 1]
    ? argv[dirFlagIdx + 1]
    : 'release/bug-drafts';

const mapPath = 'config/jira-priority-map.json';

for (const [label, p] of [
  ['priority map', mapPath],
  ['context.json', 'context.json'],
]) {
  if (!existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    exit(2);
  }
}
if (!existsSync(draftsDir)) {
  console.error(`Bug-drafts dir not found: ${draftsDir}`);
  exit(2);
}

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const context = loadJson('context.json');
const map = loadJson(mapPath);

const sevToPriority = map.severity_to_priority || {};
const defaultPriority = map.default_priority || 'Medium';
const linkType = map.link_type || 'Relates';
const issueType =
  env[map.issue_type_env || 'JIRA_BUG_ISSUETYPE'] ||
  map.default_issue_type ||
  'Bug';

// --- Parse a bug draft into its level-2 sections -------------------------
// Splits on lines that are exactly "## Heading"; the H1 ("# BUG-XXX") is
// captured separately. Returns { bugId, sections: { Summary, Severity, ... } }.
function parseDraft(md, file) {
  const lines = md.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  const bugId = h1 ? h1.replace(/^#\s+/, '').trim() : null;
  const sections = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) sections[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      current = h2[1];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  if (!bugId) throw new Error(`${file}: no '# BUG-XXX' heading found`);
  return { bugId, sections, file };
}

const REQUIRED_SECTIONS = [
  'Summary',
  'Severity',
  'Linked Story',
  'Linked Failure',
  'Linked Risk',
  'Linked Test Case',
  'Steps to Reproduce',
  'Expected Behavior',
  'Actual Behavior',
  'Environment',
  'Evidence',
  'Jira Issue Key',
];

// --- Collect drafts ------------------------------------------------------
const draftFiles = readdirSync(draftsDir)
  .filter((f) => /^BUG-.+\.md$/i.test(f))
  .sort();

if (draftFiles.length === 0) {
  console.log(`No BUG-*.md drafts in ${draftsDir}. Nothing to promote.`);
  exit(0);
}

const drafts = draftFiles.map((f) => {
  const full = `${draftsDir}/${f}`;
  return { ...parseDraft(readFileSync(full, 'utf8'), full), path: full };
});

// Validate structure before doing anything.
for (const d of drafts) {
  const missing = REQUIRED_SECTIONS.filter((s) => !(s in d.sections));
  if (missing.length) {
    console.error(
      `${d.path}: missing required section(s): ${missing.join(', ')}. ` +
        `See docs/bug-draft-format.md.`
    );
    exit(1);
  }
}

const storyKey = context.story?.jira_issue_key || null;
const storyId = context.story?.id || '(unknown story)';

// Build the Jira description (plain text; the REST v3 call wraps it in ADF).
function buildDescription(d) {
  const s = d.sections;
  return [
    s['Summary'],
    '',
    `Linked Story: ${s['Linked Story']}`,
    `Linked Failure: ${s['Linked Failure']}`,
    `Linked Risk: ${s['Linked Risk']}`,
    `Linked Test Case: ${s['Linked Test Case']}`,
    '',
    'Steps to Reproduce:',
    s['Steps to Reproduce'],
    '',
    'Expected Behavior:',
    s['Expected Behavior'],
    '',
    'Actual Behavior:',
    s['Actual Behavior'],
    '',
    'Environment:',
    s['Environment'],
    '',
    'Evidence:',
    s['Evidence'],
    '',
    `(Filed by scripts/create-jira-bugs.js from ${d.path})`,
  ].join('\n');
}

// --- Plan -----------------------------------------------------------------
const toCreate = [];
const skipped = [];
for (const d of drafts) {
  const existingKey = d.sections['Jira Issue Key'].trim();
  // A bracketed placeholder ("[empty ...]") counts as empty.
  const hasKey = existingKey && !/^\[.*\]$/.test(existingKey);
  if (hasKey) {
    skipped.push({ ...d, existingKey });
    continue;
  }
  const sev = d.sections['Severity'].trim().toLowerCase();
  const priority = sevToPriority[sev] || defaultPriority;
  toCreate.push({ ...d, severity: sev, priority });
}

const projectKey = env.JIRA_PROJECT_KEY;

console.log(`Jira bug promotion plan`);
console.log(`  Project: ${projectKey ?? '(unset)'}`);
console.log(`  Issue type: ${issueType}`);
console.log(
  `  Story: ${storyId}${storyKey ? ` (Jira ${storyKey})` : ' (no jira_issue_key — bugs will not be linked)'}`
);
console.log(`  Drafts found: ${drafts.length}`);
console.log(`  Already filed (skipped): ${skipped.length}`);
for (const s of skipped) {
  console.log(`    - ${s.bugId} already has Jira key ${s.existingKey}`);
}
console.log(`  To create: ${toCreate.length}`);
for (const c of toCreate) {
  console.log(
    `    - ${c.bugId} (severity=${c.severity} -> priority=${c.priority}) "${c.sections['Summary'].split('\n')[0]}"`
  );
}

if (toCreate.length === 0) {
  console.log('\nNothing to create.');
  exit(0);
}

if (!APPLY) {
  console.log(
    '\nDRY RUN (no Jira writes). Re-run with --apply to file these in Jira.'
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

// Jira Cloud REST v3 description is Atlassian Document Format (ADF). Wrap
// the plain text as one paragraph per line.
function adf(text) {
  const content = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));
  return { type: 'doc', version: 1, content };
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
    /* non-JSON body (e.g. empty 204) */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// Write the new Jira key back into the draft's "## Jira Issue Key" section.
function writeBackKey(draftPath, key) {
  const md = readFileSync(draftPath, 'utf8');
  const updated = md.replace(
    /(##\s+Jira Issue Key\s*\n)([\s\S]*?)(?=\n##\s|\s*$)/,
    `$1\n${key}\n`
  );
  writeFileSync(draftPath, updated);
}

async function main() {
  let created = 0;
  for (const c of toCreate) {
    const summary = c.sections['Summary'].split('\n')[0].slice(0, 250);
    const fields = {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueType },
      description: adf(buildDescription(c)),
      priority: { name: c.priority },
    };

    let r = await jira('/rest/api/3/issue', 'POST', { fields });
    // Some projects reject the `priority` field (no priority scheme). Retry
    // once without it rather than failing the whole promotion.
    if (!r.ok && r.text && /priority/i.test(r.text) && 'priority' in fields) {
      console.warn(
        `  ${c.bugId}: project rejected 'priority'; retrying without it.`
      );
      delete fields.priority;
      r = await jira('/rest/api/3/issue', 'POST', { fields });
    }
    if (!r.ok) {
      throw new Error(
        `${c.bugId}: create failed (HTTP ${r.status}): ${r.text.slice(0, 500)}`
      );
    }
    const key = r.json.key;
    console.log(`  ${c.bugId} -> created ${key}`);

    // Link to the story issue when we have its key.
    if (storyKey) {
      const lr = await jira('/rest/api/3/issueLink', 'POST', {
        type: { name: linkType },
        inwardIssue: { key },
        outwardIssue: { key: storyKey },
      });
      if (lr.ok) {
        console.log(`      linked ${key} --[${linkType}]--> ${storyKey}`);
      } else {
        console.warn(
          `      WARN: could not link ${key} to ${storyKey} ` +
            `(HTTP ${lr.status}): ${lr.text.slice(0, 200)}. Bug created; link skipped.`
        );
      }
    }

    writeBackKey(c.path, key);
    console.log(`      wrote ${key} back into ${c.path}`);
    created += 1;
  }
  console.log(`\nDone. Created ${created} Jira issue(s).`);
}

main().catch((e) => {
  console.error(`\nJira bug promotion FAILED: ${e.message}`);
  exit(1);
});
