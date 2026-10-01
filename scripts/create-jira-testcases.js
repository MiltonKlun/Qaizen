#!/usr/bin/env node
// @ts-check
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
// Recoverable by design (task group 5.1): before each create the intent is
// saved (sync_state.jira, state "pending"); the returned key is saved the
// moment Jira acknowledges it, before linking or the next case. A create
// whose outcome is unknown (timeout, dropped connection, unreadable reply)
// stays "pending" and blocks further creates until it is reconciled — by a
// read-only search for the operation's marker label (--reconcile), or by a
// human (--resolve). A create is never blindly retried.
//
// Destination selection: this script only runs the Jira adapter. It refuses
// to run unless TEST_MANAGEMENT_TOOL selects "jira" (values: jira | both).
//
// Usage:
//   node scripts/create-jira-testcases.js <story-id>                 # dry-run
//   node scripts/create-jira-testcases.js <story-id> --apply         # real writes
//   node scripts/create-jira-testcases.js <story-id> --apply --limit 5
//   node scripts/create-jira-testcases.js <story-id> --reconcile     # settle pending creates
//   node scripts/create-jira-testcases.js <story-id> --resolve TC-001=SK-12   # human resolution
//   node scripts/create-jira-testcases.js <story-id> --resolve TC-001=none
//   ... --release-stale-lock   # take over the lock of a sync that is no longer running
//
// Env (.env or process.env): TEST_MANAGEMENT_TOOL, JIRA_URL, JIRA_USERNAME,
//   JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_TESTCASE_ISSUETYPE (default Test),
//   QAIZEN_HTTP_TIMEOUT_MS (default 30000).
//
// Exit codes: 0 ok · 1 sync/gate/recovery error · 2 usage/file/env/selection error

import { existsSync } from 'node:fs';
/** @typedef {import('./lib/execution-ledger.js').TestCase} TestCase */
/** @typedef {import('./lib/integration-io.js').SyncRecord} SyncRecord */
/** @typedef {ReturnType<typeof import('./lib/integration-io.js').jiraClient>} JiraClient */
import { argv, env, exit } from 'node:process';

import {
  readJson,
  readValidatedJson,
  writeJsonAtomic,
  formatErrors,
} from './lib/artifact-io.js';
import { semanticCase } from './lib/approval-binding.js';
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
  describeSkip,
  planOperation,
  sourceDigest,
  selectTestManagementTarget,
} from './lib/integration-io.js';
import {
  loadDotEnv,
  parseCli,
  parseResolutions,
  validateStoryId,
} from './lib/cli.js';

const TARGET = 'jira';
const SCHEMA = 'schemas/test-cases.schema.json';

async function main() {
  loadDotEnv(env);

  const USAGE =
    'Usage: node scripts/create-jira-testcases.js <story-id> [--apply [--limit N] | --reconcile | --resolve TC-ID=KEY|none] [--release-stale-lock]\n' +
    '  Options may come before or after <story-id>.';
  const cli = parseCli(argv.slice(2), {
    usage: USAGE,
    positionals: [{ name: 'story-id', validate: validateStoryId }],
    options: {
      apply: { type: 'boolean' },
      limit: { type: 'integer', min: 1 },
      reconcile: { type: 'boolean' },
      resolve: { type: 'string', multiple: true },
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
  const LIMIT =
    /** @type {number | undefined} */ (cli.values.limit) ?? Infinity;
  let resolutions;
  try {
    resolutions = parseResolutions(
      /** @type {string[] | undefined} */ (cli.values.resolve) ?? []
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }
  const storyId = cli.positionals['story-id'];

  // --- Destination selection (the port's TEST_MANAGEMENT_TOOL) -----------
  const selected = selectTestManagementTarget(env.TEST_MANAGEMENT_TOOL, TARGET);
  if (!selected.ok) {
    console.error(selected.reason);
    return 2;
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
      return 2;
    }
  }

  // --- Validate every input before anything touches Jira -----------------
  const docRead = readValidatedJson(casesPath, SCHEMA);
  if (!docRead.ok) {
    console.error(docRead.message);
    for (const line of formatErrors(docRead.errors)) console.error(line);
    return 2;
  }
  const doc = docRead.data;
  const ctxRead = readJson('context.json');
  const mapRead = readJson(mapPath);
  if (!ctxRead.ok) {
    console.error(ctxRead.message);
    return 2;
  }
  if (!mapRead.ok) {
    console.error(mapRead.message);
    return 2;
  }
  const context = ctxRead.data;
  const map = mapRead.data;

  const scope = checkSyncScope(context, doc, storyId, '.');
  if (!scope.ok) {
    console.error(`${scope.reason}. Refusing to sync.`);
    return 1;
  }

  const writebackKey = map.writeback_key || TARGET;
  if (writebackKey !== TARGET) {
    console.error(
      `config/jira-testcase-map.json writeback_key is "${writebackKey}", but this adapter records Jira keys under external_ids.${TARGET}. ` +
        `Recording them under another tool's name would make the two adapters overwrite each other.`
    );
    return 2;
  }
  const syncStatuses = map.sync_only_status || ['approved'];
  const issueType =
    env[map.issue_type_env || 'JIRA_TESTCASE_ISSUETYPE'] ||
    map.default_issue_type ||
    'Test';
  const priorityMap = map.priority_map || null;
  const staticLabels = map.labels || [];
  const linkType = map.link_type || 'Relates';
  const storyKey = context.story?.jira_issue_key || null;
  const projectKey = env.JIRA_PROJECT_KEY || null;

  // --- Plan: one action per approved case --------------------------------
  /** @type {TestCase[]} */
  const approved = doc.test_cases.filter((/** @type {TestCase} */ tc) =>
    syncStatuses.includes(tc.status)
  );
  /** @type {(tc: TestCase) => SyncRecord | undefined} */
  const recordOf = (tc) => tc.sync_state?.[TARGET];
  /** @type {(tc: TestCase) => string | undefined} */
  const remoteOf = (tc) => tc.external_ids?.[writebackKey];
  const plan = approved.map((tc) => ({
    tc,
    ...planOperation({
      record: recordOf(tc),
      remoteIds: [remoteOf(tc)],
      isValidId: (/** @type {string} */ id) => JIRA_KEY.test(id),
      linkWanted: Boolean(storyKey),
    }),
  }));
  const byAction = (/** @type {string} */ a) =>
    plan.filter((p) => p.action === a);
  const toCreate = byAction('create');
  const limited = toCreate.slice(0, LIMIT);

  console.log(
    `Jira test-case sync plan for ${storyId} (TEST_MANAGEMENT_TOOL=${selected.tool})`
  );
  console.log(
    `  Project: ${projectKey ?? '(unset)'}  ·  Issue type: ${issueType}`
  );
  console.log(
    `  Story link: ${storyKey ? `${storyKey} (${linkType})` : '(no jira_issue_key — cases will not be linked)'}`
  );
  console.log(`  Approved cases: ${approved.length}`);
  for (const p of plan) {
    const { tc } = p;
    let label;
    if (p.action === 'create') {
      const pr = priorityMap
        ? `, priority ${priorityMap[tc.priority] || '(default)'}`
        : '';
      label = limited.includes(p)
        ? `CREATE${pr}`
        : `CREATE later (beyond --limit ${LIMIT})`;
    } else if (p.action === 'skip') {
      label = `SKIP (in Jira as ${p.id}; ${describeSkip(recordOf(tc), sourceDigest(semanticCase(tc)), 'Jira')})`;
    } else if (p.action === 'link') {
      label = `LINK ONLY (${p.id} exists; retry its link to ${storyKey})`;
    } else if (p.action === 'reconcile') {
      // A reconcile action always has its pending record (planOperation).
      const r = /** @type {SyncRecord} */ (recordOf(tc));
      label = `RECONCILE FIRST (${p.reason}; marker ${r.marker}${r.marker_searchable === false ? ', not searchable' : ''})`;
    } else {
      label = `BLOCKED (${p.reason})`;
    }
    console.log(`    - ${tc.test_case_id} "${tc.title}" -> ${label}`);
  }
  console.log(
    `  Create ${limited.length} · skip ${byAction('skip').length} · link ${byAction('link').length} · ` +
      `reconcile ${byAction('reconcile').length} · blocked ${byAction('blocked').length}. ` +
      `Existing Jira issues are never updated by this adapter.`
  );

  if (!APPLY && !RECONCILE && resolutions.length === 0) {
    console.log(
      '\nDRY RUN (no Jira writes, no local changes). Re-run with --apply to create these.'
    );
    return 0;
  }

  if (!projectKey) {
    console.error('JIRA_PROJECT_KEY is required to identify the operations.');
    return 2;
  }
  // Set from here on; the nested functions below read this binding.
  const project = projectKey;

  // --- Everything below may write: hold the Jira lock --------------------
  const lock = acquireLock('.', TARGET, { releaseStale: RELEASE_STALE });
  if (!lock.ok) {
    console.error(`Refusing to sync: ${lock.reason}`);
    return 1;
  }
  try {
    const persist = () =>
      writeJsonAtomic(casesPath, doc, { schemaPath: SCHEMA });
    const now = () => new Date().toISOString();

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
      console.error(e instanceof Error ? e.message : e);
      return 2;
    }
    const jira = jiraClient({
      baseUrl: jiraUrl,
      user: env.JIRA_USERNAME,
      token: env.JIRA_API_TOKEN,
      timeoutMs,
    });

    if (RECONCILE) return await reconcile(jira);

    // --- Apply --------------------------------------------------------
    if (byAction('reconcile').length) {
      console.error(
        `\nRefusing to create: ${byAction('reconcile').length} earlier create(s) have an unknown outcome. ` +
          `Run with --reconcile first, so nothing is created twice.`
      );
      return 1;
    }

    let created = 0;
    let linkFailures = 0;
    for (const { tc } of byAction('link')) {
      if (!(await link(jira, tc))) linkFailures += 1;
    }
    for (const { tc } of limited) {
      const outcome = await create(jira, tc);
      if (outcome !== 'created') return 1;
      created += 1;
      if (storyKey && !(await link(jira, tc))) linkFailures += 1;
    }
    console.log(
      `\nDone. Created ${created} Jira issue(s); each key was saved to ${casesPath} as it was created.`
    );
    if (linkFailures) {
      console.warn(
        `${linkFailures} story link(s) failed; the issues exist and their keys are saved. Re-run --apply to retry only the links.`
      );
    }
    if (byAction('blocked').length) {
      console.error(
        `${byAction('blocked').length} case(s) are BLOCKED and were not touched; correct them in ${casesPath} (see the plan above).`
      );
      return 1;
    }
    return 0;

    // ------------------------------------------------------------------
    /**
     * @param {JiraClient} client
     * @param {TestCase} tc
     */
    async function create(client, tc) {
      const key = operationKey({
        target: TARGET,
        project,
        storyId,
        localId: tc.test_case_id,
        kind: 'create_case',
      });
      const marker = operationMarker(key);
      /** @type {Record<string, any>} the Jira issue fields */
      const fields = {
        project: { key: project },
        summary: summaryFor(tc).slice(0, 250),
        issuetype: { name: issueType },
        description: adf(descriptionFor(tc)),
        labels: [...staticLabels, doc.story_id, tc.test_case_id, marker].map(
          (l) => String(l).replace(/\s+/g, '-')
        ),
      };
      if (priorityMap && priorityMap[tc.priority]) {
        fields.priority = { name: priorityMap[tc.priority] };
      }

      /** @type {SyncRecord} */
      const record = {
        operation_key: key,
        marker,
        marker_searchable: true,
        payload_digest: payloadDigest(fields),
        source_digest: sourceDigest(semanticCase(tc)),
        state: SYNC_STATE.PENDING,
        intent_at: now(),
        updated_at: now(),
      };
      tc.sync_state = { ...tc.sync_state, [TARGET]: record };
      const saved = persist();
      if (!saved.ok) {
        console.error(
          `${tc.test_case_id}: could not save the intent before creating (${saved.message}). Nothing was sent.`
        );
        return 'aborted';
      }

      let out = await client.createIssue(fields);
      // A definite 400 naming an optional field: resend without that field.
      // Safe because a rejected request created nothing. Dropping the labels
      // also drops the marker, which the record states before resending.
      if (out.outcome === 'rejected' && out.status === 400) {
        const dropPriority =
          'priority' in fields && /priority/i.test(out.detail);
        const dropLabels = /labels/i.test(out.detail);
        if (dropPriority || dropLabels) {
          if (dropPriority) delete fields.priority;
          if (dropLabels) delete fields.labels;
          console.warn(
            `  ${tc.test_case_id}: project rejected ${[dropPriority && 'priority', dropLabels && 'labels'].filter(Boolean).join(' and ')}; resending without.`
          );
          record.payload_digest = payloadDigest(fields);
          if (dropLabels) record.marker_searchable = false;
          record.updated_at = now();
          const again = persist();
          if (!again.ok) {
            console.error(
              `${tc.test_case_id}: could not save the updated intent (${again.message}). Nothing more was sent.`
            );
            return 'aborted';
          }
          out = await client.createIssue(fields);
        }
      }

      if (out.outcome === 'created') {
        tc.external_ids = { ...tc.external_ids, [writebackKey]: out.id };
        Object.assign(record, {
          state: SYNC_STATE.CREATED,
          remote_id: out.id,
          created_at: now(),
          updated_at: now(),
          link_state: storyKey ? 'pending' : 'not_applicable',
        });
        delete record.last_error;
        const kept = persist();
        if (!kept.ok) {
          console.error(
            `\nCRITICAL: Jira created ${out.id} for ${tc.test_case_id}, but it could not be saved (${kept.message}).\n` +
              `Record it before doing anything else:\n` +
              `  node scripts/create-jira-testcases.js ${storyId} --resolve ${tc.test_case_id}=${out.id}`
          );
          return 'aborted';
        }
        console.log(`  ${tc.test_case_id} -> created ${out.id}`);
        return 'created';
      }

      if (out.outcome === 'rejected') {
        Object.assign(record, {
          state: SYNC_STATE.FAILED,
          last_error: out.detail.slice(0, 500),
          updated_at: now(),
        });
        const kept = persist();
        console.error(
          `${tc.test_case_id}: Jira rejected the create (${out.detail}). Nothing was created.` +
            (kept.ok ? '' : ` (Could not record the failure: ${kept.message}.)`)
        );
        return 'rejected';
      }

      // Ambiguous: the intent stays pending.
      record.last_error = out.detail.slice(0, 500);
      record.updated_at = now();
      const kept = persist();
      console.error(
        `${tc.test_case_id}: the outcome of the create is unknown (${out.detail}).\n` +
          `It may exist in Jira. Stopped before any other create. Run:\n` +
          `  node scripts/create-jira-testcases.js ${storyId} --reconcile` +
          (kept.ok
            ? ''
            : `\n(Could not record the diagnostic: ${kept.message}; the pending intent was saved earlier.)`)
      );
      return 'ambiguous';
    }

    /**
     * @param {JiraClient} client
     * @param {TestCase} tc a case whose create is recorded (planOperation)
     */
    async function link(client, tc) {
      const record = /** @type {SyncRecord} */ (recordOf(tc));
      const remote = /** @type {string} */ (remoteOf(tc));
      const res = await client.linkToStory(remote, storyKey, linkType);
      if (res.ok) {
        Object.assign(record, {
          link_state: 'linked',
          linked_at: now(),
          updated_at: now(),
        });
        delete record.last_error;
        console.log(`      linked ${remote} --[${linkType}]--> ${storyKey}`);
      } else {
        Object.assign(record, {
          link_state: 'failed',
          last_error: `link: ${res.detail}`.slice(0, 500),
          updated_at: now(),
        });
        console.warn(
          `      WARN: link ${remote}->${storyKey} failed (${res.detail}); the issue exists, the link will be retried on the next --apply.`
        );
      }
      const kept = persist();
      if (!kept.ok) {
        console.warn(
          `      WARN: could not save the link state (${kept.message}); the next --apply may retry this link.`
        );
      }
      return res.ok;
    }

    /** @param {JiraClient} client */
    async function reconcile(client) {
      const pending = byAction('reconcile');
      if (!pending.length) {
        console.log('\nNothing to reconcile.');
        return 0;
      }
      let unresolved = 0;
      for (const { tc } of pending) {
        // A pending operation always has its record (planOperation).
        const record = /** @type {SyncRecord} */ (recordOf(tc));
        if (record.marker_searchable === false) {
          unresolved += 1;
          console.error(
            `  ${tc.test_case_id}: its create was sent without the marker label, so it cannot be found automatically. ` +
              `Search Jira for "${tc.test_case_id}", then run --resolve ${tc.test_case_id}=<KEY> or --resolve ${tc.test_case_id}=none.`
          );
          continue;
        }
        const found = await client.findByMarker(project, record.marker);
        if (!found.ok) {
          unresolved += 1;
          console.error(
            `  ${tc.test_case_id}: search failed (${found.detail}); still pending.`
          );
          continue;
        }
        if (found.keys.length > 1) {
          unresolved += 1;
          console.error(
            `  ${tc.test_case_id}: ${found.keys.length} issues carry ${record.marker} (${found.keys.join(', ')}). ` +
              `Decide which one is the test case, then --resolve ${tc.test_case_id}=<KEY>.`
          );
          continue;
        }
        if (found.keys.length === 1) {
          adopt(tc, found.keys[0]);
          console.log(
            `  ${tc.test_case_id} -> found ${found.keys[0]} (created earlier)`
          );
        } else {
          markNotFound(tc);
          console.log(
            `  ${tc.test_case_id} -> not in Jira; it will be created on the next --apply`
          );
        }
        const kept = persist();
        if (!kept.ok) {
          console.error(`Could not save the reconciliation: ${kept.message}`);
          return 1;
        }
      }
      return unresolved ? 1 : 0;
    }

    /** @param {{ localId: string, remote: string | null }[]} list */
    function resolve(list) {
      for (const { localId, remote } of list) {
        const tc = approved.find((t) => t.test_case_id === localId);
        if (!tc) {
          console.error(
            `--resolve: ${localId} is not an approved case of ${storyId}.`
          );
          return 2;
        }
        const record = recordOf(tc);
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
        if (remote) adopt(tc, remote);
        else markNotFound(tc);
        console.log(
          `  ${localId} -> ${remote ?? 'not created'} (resolved by hand)`
        );
      }
      const kept = persist();
      if (!kept.ok) {
        console.error(`Could not save the resolution: ${kept.message}`);
        return 1;
      }
      return 0;
    }

    /**
     * @param {TestCase} tc
     * @param {string} remote
     */
    function adopt(tc, remote) {
      tc.external_ids = { ...tc.external_ids, [writebackKey]: remote };
      // Callers adopt only a case with a pending record.
      const record = /** @type {SyncRecord} */ (recordOf(tc));
      Object.assign(record, {
        state: SYNC_STATE.CREATED,
        remote_id: remote,
        reconciled_at: now(),
        updated_at: now(),
        link_state: storyKey ? 'pending' : 'not_applicable',
      });
      delete record.last_error;
    }

    /** @param {TestCase} tc */
    function markNotFound(tc) {
      // Callers mark only a case with a pending record.
      Object.assign(/** @type {SyncRecord} */ (recordOf(tc)), {
        state: SYNC_STATE.NOT_FOUND,
        reconciled_at: now(),
        updated_at: now(),
      });
    }
  } finally {
    lock.release();
  }

  /** @param {TestCase} tc */
  function summaryFor(tc) {
    return (map.summary_template || '{test_case_id} {title}')
      .replace('{test_case_id}', tc.test_case_id)
      .replace('{title}', tc.title);
  }

  /** @param {TestCase} tc */
  function descriptionFor(tc) {
    /** @type {string[]} */
    const lines = [];
    if (tc.description) lines.push(tc.description, '');
    if (tc.preconditions?.length) {
      lines.push('Preconditions:');
      tc.preconditions.forEach((/** @type {string} */ p) =>
        lines.push(`- ${p}`)
      );
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
}

main().then(
  (code) => exit(code),
  (e) => {
    console.error(`\nJira test-case sync FAILED: ${e.message}`);
    exit(1);
  }
);
