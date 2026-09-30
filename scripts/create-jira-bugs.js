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
// Recoverable by design (task group 5.1): each draft carries a machine-
// readable "## Sync State" section (docs/bug-draft-format.md). The intent is
// saved there before the create, and the key (in "## Jira Issue Key" and the
// sync state) the moment Jira returns it, before linking or the next draft. A
// create whose outcome is unknown stays pending and blocks further creates
// until --reconcile finds it by its marker label, or a human resolves it with
// --resolve. A create is never blindly retried.
//
// It talks to the Jira REST API directly (same approach the codebase uses
// for TestLink XML-RPC in scripts/sync-to-testlink.js): the MCP isn't
// reachable from a plain Node script and CI has no agent. The credentials
// are exactly those the atlassian-write MCP uses.
//
// Usage:
//   node scripts/create-jira-bugs.js                    # dry-run (default)
//   node scripts/create-jira-bugs.js --apply            # real Jira writes
//   node scripts/create-jira-bugs.js --reconcile        # settle pending creates
//   node scripts/create-jira-bugs.js --resolve BUG-001=SK-12   # human resolution
//   node scripts/create-jira-bugs.js --resolve BUG-001=none
//   node scripts/create-jira-bugs.js --dir <path>       # override drafts dir
//   ... --release-stale-lock   # take over the lock of a sync that is no longer running
//
// Env (loaded from .env if present, else process.env):
//   JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN  — same as the read MCP
//   JIRA_PROJECT_KEY                          — target project (e.g. SK)
//   JIRA_BUG_ISSUETYPE                        — default "Bug"
//   QAIZEN_HTTP_TIMEOUT_MS                    — default 30000
//
// Config: config/jira-priority-map.json (severity -> priority, link type).
//
// Exit codes: 0 ok · 1 promotion/parse/scope/recovery error · 2 usage/file/env error

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

import {
  readJson,
  readValidatedJson,
  validateValue,
  writeTextAtomic,
  formatErrors,
} from './lib/artifact-io.js';
import {
  JIRA_KEY,
  SYNC_STATE,
  acquireLock,
  adf,
  checkSyncScope,
  httpTimeoutMs,
  jiraClient,
  operationKey,
  operationMarker,
  payloadDigest,
  planOperation,
} from './lib/integration-io.js';
import { loadDotEnv, parseCli, parseResolutions } from './lib/cli.js';

const TARGET = 'jira';
const SCHEMA = 'schemas/test-cases.schema.json';
const SYNC_FRAGMENT = '#/definitions/syncState';

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

/** The JSON inside "## Sync State" (a ```json fenced block), or null. */
function parseSyncState(body, file) {
  if (body === undefined) return null;
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${file}: "## Sync State" has no \`\`\`json block`);
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(
      `${file}: "## Sync State" is not valid JSON (${e.message})`
    );
  }
}

/**
 * Replace a level-2 section's body, or append the section when absent.
 * Keeps the file's line endings.
 */
function setSection(md, heading, body) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  const block = ['', ...body.split('\n'), ''];
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return [...lines, '', `## ${heading}`, ...block].join(eol);
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  const after = lines.slice(end);
  const out = [...lines.slice(0, start + 1), ...block, ...after];
  if (after.length === 0) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('');
  }
  return out.join(eol);
}

const isPlaceholder = (s) => !s || /^\[.*\]$/.test(s);

async function main() {
  loadDotEnv(env);

  const USAGE =
    'Usage: node scripts/create-jira-bugs.js [--apply | --reconcile | --resolve BUG-ID=KEY|none] [--dir <path>] [--release-stale-lock]';
  const cli = parseCli(argv.slice(2), {
    usage: USAGE,
    options: {
      apply: { type: 'boolean' },
      reconcile: { type: 'boolean' },
      resolve: { type: 'string', multiple: true },
      dir: { type: 'string' },
      'release-stale-lock': { type: 'boolean' },
    },
    exclusive: [['apply', 'reconcile', 'resolve']],
  });
  if (!cli.ok) {
    console.error(`Error: ${cli.error}`);
    console.error(USAGE);
    return 2;
  }
  const APPLY = cli.values.apply === true;
  const RECONCILE = cli.values.reconcile === true;
  const RELEASE_STALE = cli.values['release-stale-lock'] === true;
  let resolutions;
  try {
    resolutions = parseResolutions(
      /** @type {string[] | undefined} */ (cli.values.resolve) ?? []
    );
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const draftsDir =
    /** @type {string | undefined} */ (cli.values.dir) ?? 'release/bug-drafts';

  const mapPath = 'config/jira-priority-map.json';
  for (const [label, p] of [
    ['priority map', mapPath],
    ['context.json', 'context.json'],
  ]) {
    if (!existsSync(p)) {
      console.error(`Missing ${label}: ${p}`);
      return 2;
    }
  }
  if (!existsSync(draftsDir)) {
    console.error(`Bug-drafts dir not found: ${draftsDir}`);
    return 2;
  }

  const ctxRead = readJson('context.json');
  const mapRead = readJson(mapPath);
  for (const r of [ctxRead, mapRead]) {
    if (!r.ok) {
      console.error(r.message);
      return 2;
    }
  }
  const context = ctxRead.data;
  const map = mapRead.data;

  const sevToPriority = map.severity_to_priority || {};
  const defaultPriority = map.default_priority || 'Medium';
  const linkType = map.link_type || 'Relates';
  const issueType =
    env[map.issue_type_env || 'JIRA_BUG_ISSUETYPE'] ||
    map.default_issue_type ||
    'Bug';

  // --- Collect drafts ------------------------------------------------------
  const draftFiles = readdirSync(draftsDir)
    .filter((f) => /^BUG-.+\.md$/i.test(f))
    .sort();
  if (draftFiles.length === 0) {
    console.log(`No BUG-*.md drafts in ${draftsDir}. Nothing to promote.`);
    return 0;
  }

  let drafts;
  try {
    drafts = draftFiles.map((f) => {
      const path = `${draftsDir}/${f}`;
      const md = readFileSync(path, 'utf8');
      const parsed = parseDraft(md, path);
      return {
        ...parsed,
        path,
        md,
        syncState: parseSyncState(parsed.sections['Sync State'], path) ?? {},
      };
    });
  } catch (e) {
    console.error(e.message);
    return 1;
  }

  // --- Validate every draft and its scope before anything touches Jira -----
  for (const d of drafts) {
    const missing = REQUIRED_SECTIONS.filter((s) => !(s in d.sections));
    if (missing.length) {
      console.error(
        `${d.path}: missing required section(s): ${missing.join(', ')}. ` +
          `See docs/bug-draft-format.md.`
      );
      return 1;
    }
    const valid = validateValue(d.syncState, SCHEMA, {
      fragment: SYNC_FRAGMENT,
    });
    if (!valid.ok) {
      console.error(`${d.path}: "## Sync State" is invalid. ${valid.message}`);
      for (const line of formatErrors(valid.errors)) console.error(line);
      return 1;
    }
    const key = d.sections['Jira Issue Key'].trim();
    // A malformed key is planned as BLOCKED below, like any recorded id.
    d.existingKey = isPlaceholder(key) ? null : key;
  }

  const storyKey = context.story?.jira_issue_key || null;
  const storyId = context.story?.id;
  if (!storyId) {
    console.error('context.json has no story.id. Refusing to promote.');
    return 1;
  }
  const casesPath =
    context.artifact_paths?.test_cases || `test-cases/${storyId}.json`;
  const casesRead = readValidatedJson(casesPath, SCHEMA);
  if (!casesRead.ok) {
    console.error(`${casesRead.message}. Refusing to promote.`);
    return 1;
  }
  const scope = checkSyncScope(context, casesRead.data, storyId, '.');
  if (!scope.ok) {
    console.error(`${scope.reason}. Refusing to promote.`);
    return 1;
  }
  const approvedIds = new Set(
    casesRead.data.test_cases
      .filter((tc) => tc.status === 'approved')
      .map((tc) => tc.test_case_id)
  );
  for (const d of drafts) {
    const linkedStory = d.sections['Linked Story'].split(/\s+/)[0];
    if (linkedStory !== storyId) {
      console.error(
        `${d.path}: linked to story ${linkedStory}, but the active story is ${storyId}. Refusing to promote.`
      );
      return 1;
    }
    const tcRef = d.sections['Linked Test Case'].split(/\s+/)[0];
    if (/traceability_unresolved/.test(d.sections['Linked Test Case'])) {
      console.warn(
        `${d.path}: its test case is traceability_unresolved; it is promoted on the story match alone.`
      );
    } else if (!approvedIds.has(tcRef)) {
      console.error(
        `${d.path}: linked to test case ${tcRef}, which is not an approved case of ${storyId}. Refusing to promote.`
      );
      return 1;
    }
  }

  // --- Plan -----------------------------------------------------------------
  const recordOf = (d) => d.syncState[TARGET];
  const plan = drafts.map((d) => ({
    d,
    ...planOperation({
      record: recordOf(d),
      remoteIds: [d.existingKey],
      isValidId: (id) => JIRA_KEY.test(id),
      linkWanted: Boolean(storyKey),
    }),
  }));
  const byAction = (a) => plan.filter((p) => p.action === a);
  const projectKey = env.JIRA_PROJECT_KEY || null;

  console.log(`Jira bug promotion plan`);
  console.log(`  Project: ${projectKey ?? '(unset)'}`);
  console.log(`  Issue type: ${issueType}`);
  console.log(
    `  Story: ${storyId}${storyKey ? ` (Jira ${storyKey})` : ' (no jira_issue_key — bugs will not be linked)'}`
  );
  console.log(`  Drafts found: ${drafts.length}`);
  console.log(`  Already filed (skipped): ${byAction('skip').length}`);
  for (const { d } of byAction('skip')) {
    console.log(`    - ${d.bugId} already has Jira key ${d.existingKey}`);
  }
  if (byAction('link').length) {
    console.log(
      `  Link to retry (filed, not yet linked): ${byAction('link').length}`
    );
    for (const { d } of byAction('link')) {
      console.log(`    - ${d.bugId} (${d.existingKey}) -> ${storyKey}`);
    }
  }
  if (byAction('reconcile').length) {
    console.log(
      `  Outcome unknown (pending; must be reconciled before any create): ${byAction('reconcile').length}`
    );
    for (const { d } of byAction('reconcile')) {
      console.log(
        `    - ${d.bugId} (marker ${recordOf(d).marker}, since ${recordOf(d).intent_at})`
      );
    }
  }
  if (byAction('blocked').length) {
    console.log(
      `  Blocked (never filed or treated as filed until corrected): ${byAction('blocked').length}`
    );
    for (const { d, reason } of byAction('blocked')) {
      console.log(`    - ${d.bugId} (${reason})`);
    }
  }
  const toCreate = byAction('create').map(({ d }) => {
    const severity = d.sections['Severity'].trim().toLowerCase();
    return {
      d,
      severity,
      priority: sevToPriority[severity] || defaultPriority,
    };
  });
  console.log(`  To create: ${toCreate.length}`);
  for (const c of toCreate) {
    console.log(
      `    - ${c.d.bugId} (severity=${c.severity} -> priority=${c.priority}) "${c.d.sections['Summary'].split('\n')[0]}"`
    );
  }

  if (!APPLY && !RECONCILE && resolutions.length === 0) {
    if (toCreate.length === 0 && !byAction('link').length) {
      console.log('\nNothing to create.');
    } else {
      console.log(
        '\nDRY RUN (no Jira writes, no local changes). Re-run with --apply to file these in Jira.'
      );
    }
    return 0;
  }
  if (!projectKey) {
    console.error('JIRA_PROJECT_KEY is required to identify the operations.');
    return 2;
  }

  const lock = acquireLock('.', TARGET, { releaseStale: RELEASE_STALE });
  if (!lock.ok) {
    console.error(`Refusing to promote: ${lock.reason}`);
    return 1;
  }
  try {
    const now = () => new Date().toISOString();
    const persist = (d) => {
      const valid = validateValue(d.syncState, SCHEMA, {
        fragment: SYNC_FRAGMENT,
      });
      if (!valid.ok) return valid;
      let md = setSection(
        d.md,
        'Jira Issue Key',
        d.existingKey ?? d.sections['Jira Issue Key']
      );
      md = setSection(
        md,
        'Sync State',
        ['```json', JSON.stringify(d.syncState, null, 2), '```'].join('\n')
      );
      const written = writeTextAtomic(d.path, md);
      if (written.ok) d.md = md;
      return written;
    };

    if (resolutions.length) return resolve(resolutions);

    const jiraUrl = (env.JIRA_URL || '').replace(/\/$/, '');
    if (!jiraUrl || !env.JIRA_USERNAME || !env.JIRA_API_TOKEN) {
      console.error(
        `${APPLY ? 'Apply' : 'Reconcile'} requires JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, and JIRA_PROJECT_KEY.`
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
    const jira = jiraClient({
      baseUrl: jiraUrl,
      user: env.JIRA_USERNAME,
      token: env.JIRA_API_TOKEN,
      timeoutMs,
    });

    if (RECONCILE) return await reconcile(jira);

    if (byAction('reconcile').length) {
      console.error(
        `\nRefusing to create: ${byAction('reconcile').length} earlier create(s) have an unknown outcome. ` +
          `Run with --reconcile first, so nothing is filed twice.`
      );
      return 1;
    }

    let created = 0;
    let linkFailures = 0;
    for (const { d } of byAction('link')) {
      if (!(await link(jira, d))) linkFailures += 1;
    }
    for (const c of toCreate) {
      if ((await create(jira, c)) !== 'created') return 1;
      created += 1;
      if (storyKey && !(await link(jira, c.d))) linkFailures += 1;
    }
    console.log(`\nDone. Created ${created} Jira issue(s).`);
    if (linkFailures) {
      console.warn(
        `${linkFailures} story link(s) failed; the bugs exist and their keys are saved. Re-run --apply to retry only the links.`
      );
    }
    if (byAction('blocked').length) {
      console.error(
        `${byAction('blocked').length} draft(s) are BLOCKED and were not touched; correct them (see the plan above).`
      );
      return 1;
    }
    return 0;

    // ------------------------------------------------------------------
    async function create(client, c) {
      const { d } = c;
      const key = operationKey({
        target: TARGET,
        project: projectKey,
        storyId,
        localId: d.bugId,
        kind: 'create_bug',
      });
      const marker = operationMarker(key);
      const fields = {
        project: { key: projectKey },
        summary: d.sections['Summary'].split('\n')[0].slice(0, 250),
        issuetype: { name: issueType },
        description: adf(buildDescription(d)),
        priority: { name: c.priority },
        labels: [marker],
      };
      const record = {
        operation_key: key,
        marker,
        marker_searchable: true,
        payload_digest: payloadDigest(fields),
        state: SYNC_STATE.PENDING,
        intent_at: now(),
        updated_at: now(),
      };
      d.syncState[TARGET] = record;
      const saved = persist(d);
      if (!saved.ok) {
        console.error(
          `${d.bugId}: could not save the intent before creating (${saved.message}). Nothing was sent.`
        );
        return 'aborted';
      }

      let out = await client.createIssue(fields);
      // A definite 400 naming an optional field: resend without that field.
      // Safe because a rejected request created nothing.
      if (out.outcome === 'rejected' && out.status === 400) {
        const dropPriority =
          'priority' in fields && /priority/i.test(out.detail);
        const dropLabels = /labels/i.test(out.detail);
        if (dropPriority || dropLabels) {
          if (dropPriority) delete fields.priority;
          if (dropLabels) delete fields.labels;
          console.warn(
            `  ${d.bugId}: project rejected ${[dropPriority && 'priority', dropLabels && 'labels'].filter(Boolean).join(' and ')}; resending without.`
          );
          record.payload_digest = payloadDigest(fields);
          if (dropLabels) record.marker_searchable = false;
          record.updated_at = now();
          const again = persist(d);
          if (!again.ok) {
            console.error(
              `${d.bugId}: could not save the updated intent (${again.message}). Nothing more was sent.`
            );
            return 'aborted';
          }
          out = await client.createIssue(fields);
        }
      }

      if (out.outcome === 'created') {
        d.existingKey = out.id;
        Object.assign(record, {
          state: SYNC_STATE.CREATED,
          remote_id: out.id,
          created_at: now(),
          updated_at: now(),
          link_state: storyKey ? 'pending' : 'not_applicable',
        });
        const kept = persist(d);
        if (!kept.ok) {
          console.error(
            `\nCRITICAL: Jira created ${out.id} for ${d.bugId}, but it could not be saved to ${d.path} (${kept.message}).\n` +
              `Record it before doing anything else:\n` +
              `  node scripts/create-jira-bugs.js --resolve ${d.bugId}=${out.id}`
          );
          return 'aborted';
        }
        console.log(`  ${d.bugId} -> created ${out.id}`);
        console.log(`      wrote ${out.id} back into ${d.path}`);
        return 'created';
      }

      if (out.outcome === 'rejected') {
        Object.assign(record, {
          state: SYNC_STATE.FAILED,
          last_error: out.detail.slice(0, 500),
          updated_at: now(),
        });
        const kept = persist(d);
        console.error(
          `${d.bugId}: Jira rejected the create (${out.detail}). Nothing was created.` +
            (kept.ok ? '' : ` (Could not record the failure: ${kept.message}.)`)
        );
        return 'rejected';
      }

      record.last_error = out.detail.slice(0, 500);
      record.updated_at = now();
      const kept = persist(d);
      console.error(
        `${d.bugId}: the outcome of the create is unknown (${out.detail}).\n` +
          `It may exist in Jira. Stopped before any other create. Run:\n` +
          `  node scripts/create-jira-bugs.js --reconcile` +
          (kept.ok
            ? ''
            : `\n(Could not record the diagnostic: ${kept.message}; the pending intent was saved earlier.)`)
      );
      return 'ambiguous';
    }

    async function link(client, d) {
      const record = recordOf(d);
      const res = await client.linkToStory(d.existingKey, storyKey, linkType);
      if (res.ok) {
        Object.assign(record, {
          link_state: 'linked',
          linked_at: now(),
          updated_at: now(),
        });
        delete record.last_error;
        console.log(
          `      linked ${d.existingKey} --[${linkType}]--> ${storyKey}`
        );
      } else {
        Object.assign(record, {
          link_state: 'failed',
          last_error: `link: ${res.detail}`.slice(0, 500),
          updated_at: now(),
        });
        console.warn(
          `      WARN: could not link ${d.existingKey} to ${storyKey} (${res.detail}). Bug created; the link will be retried on the next --apply.`
        );
      }
      const kept = persist(d);
      if (!kept.ok) {
        console.warn(
          `      WARN: could not save the link state (${kept.message}); the next --apply may retry this link.`
        );
      }
      return res.ok;
    }

    async function reconcile(client) {
      const pending = byAction('reconcile');
      if (!pending.length) {
        console.log('\nNothing to reconcile.');
        return 0;
      }
      let unresolved = 0;
      for (const { d } of pending) {
        const record = recordOf(d);
        if (record.marker_searchable === false) {
          unresolved += 1;
          console.error(
            `  ${d.bugId}: its create was sent without the marker label, so it cannot be found automatically. ` +
              `Search Jira for it, then run --resolve ${d.bugId}=<KEY> or --resolve ${d.bugId}=none.`
          );
          continue;
        }
        const found = await client.findByMarker(projectKey, record.marker);
        if (!found.ok) {
          unresolved += 1;
          console.error(
            `  ${d.bugId}: search failed (${found.detail}); still pending.`
          );
          continue;
        }
        if (found.keys.length > 1) {
          unresolved += 1;
          console.error(
            `  ${d.bugId}: ${found.keys.length} issues carry ${record.marker} (${found.keys.join(', ')}). ` +
              `Decide which one is the bug, then --resolve ${d.bugId}=<KEY>.`
          );
          continue;
        }
        if (found.keys.length === 1) {
          adopt(d, found.keys[0]);
          console.log(`  ${d.bugId} -> found ${found.keys[0]} (filed earlier)`);
        } else {
          markNotFound(d);
          console.log(
            `  ${d.bugId} -> not in Jira; it will be filed on the next --apply`
          );
        }
        const kept = persist(d);
        if (!kept.ok) {
          console.error(`Could not save the reconciliation: ${kept.message}`);
          return 1;
        }
      }
      return unresolved ? 1 : 0;
    }

    function resolve(list) {
      for (const { localId, remote } of list) {
        const d = drafts.find((x) => x.bugId === localId);
        if (!d) {
          console.error(`--resolve: no draft ${localId} in ${draftsDir}.`);
          return 2;
        }
        const record = recordOf(d);
        if (!record || record.state !== SYNC_STATE.PENDING) {
          console.error(
            `--resolve: ${localId} has no unresolved operation (state ${record?.state ?? 'none'}).`
          );
          return 2;
        }
        if (remote !== null && !JIRA_KEY.test(remote)) {
          console.error(`--resolve: "${remote}" is not a Jira issue key.`);
          return 2;
        }
        if (remote) adopt(d, remote);
        else markNotFound(d);
        const kept = persist(d);
        if (!kept.ok) {
          console.error(`Could not save the resolution: ${kept.message}`);
          return 1;
        }
        console.log(
          `  ${localId} -> ${remote ?? 'not filed'} (resolved by hand)`
        );
      }
      return 0;
    }

    function adopt(d, remote) {
      d.existingKey = remote;
      Object.assign(recordOf(d), {
        state: SYNC_STATE.CREATED,
        remote_id: remote,
        reconciled_at: now(),
        updated_at: now(),
        link_state: storyKey ? 'pending' : 'not_applicable',
      });
      delete recordOf(d).last_error;
    }

    function markNotFound(d) {
      Object.assign(recordOf(d), {
        state: SYNC_STATE.NOT_FOUND,
        reconciled_at: now(),
        updated_at: now(),
      });
    }
  } finally {
    lock.release();
  }

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
}

main().then(
  (code) => exit(code),
  (e) => {
    console.error(`\nJira bug promotion FAILED: ${e.message}`);
    exit(1);
  }
);
