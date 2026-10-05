#!/usr/bin/env node
// @ts-check
// TestLink sync — the TestLink adapter behind the TestManagementAdapter
// port (agents/test-management-adapter.md), runnable from CLI/CI. Reads
// context.json + the story's test-cases JSON, filters to approved cases,
// maps fields via config/testlink-field-map.json, and either prints the
// plan (dry-run, default) or pushes to TestLink over XML-RPC
// (--apply-testlink), writing testlink_id back into the test-cases JSON.
//
// This is the SUPPORTED TestLink path. The dogkeeper886/testlink-mcp
// bridge would not complete its MCP handshake in the MCP client (see
// docs/design-decisions.md D7); this script talks to the same TestLink
// XML-RPC endpoint directly (proven working: tl.checkDevKey -> boolean 1).
//
// Source of truth is test-cases/*.json; TestLink is a downstream target.
//
// Recoverable by design (task group 5.1): the intent of each create is saved
// (sync_state.testlink, state "pending") before the request, and the new id
// the moment TestLink returns it. A create whose outcome is unknown stays
// pending and blocks further creates until --reconcile finds it (by name in
// the story's suite, confirmed by the operation marker in its summary) or a
// human resolves it with --resolve. A create is never blindly retried.
//
// Usage:
//   node scripts/sync-to-testlink.js <story-id>                  # dry-run
//   node scripts/sync-to-testlink.js <story-id> --apply-testlink # real write
//   node scripts/sync-to-testlink.js <story-id> --reconcile      # settle pending creates
//   node scripts/sync-to-testlink.js <story-id> --resolve TC-001=1234   # human resolution
//   node scripts/sync-to-testlink.js <story-id> --resolve TC-001=none
//   ... --release-stale-lock   # take over the lock of a sync that is no longer running
//
// Env (loaded from the repository's .env if present, else process.env):
//   TEST_MANAGEMENT_TOOL — must select testlink (testlink | both)
//   TESTLINK_URL  — full XML-RPC endpoint, e.g.
//                   http://host.docker.internal:8080/testlink/lib/api/xmlrpc/v1/xmlrpc.php
//                   (for a non-container CLI run use localhost, not
//                   host.docker.internal — see docs/testlink-integration.md)
//   TESTLINK_API_KEY, TESTLINK_PROJECT_KEY, TESTLINK_TEST_PLAN_ID
//   QAIZEN_HTTP_TIMEOUT_MS (default 30000)
//
// Exit codes: 0 ok · 1 sync/validation/recovery error · 2 usage/file/env error

import { existsSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

import {
  readJson,
  readValidatedJson,
  writeJsonAtomic,
  formatErrors,
} from './lib/artifact-io.js';
import { semanticCase } from './lib/approval-binding.js';
import {
  SYNC_STATE,
  acquireLock,
  checkSyncScope,
  classifyCreate,
  httpRequest,
  httpTimeoutMs,
  operationKey,
  operationMarker,
  payloadDigest,
  describeSkip,
  planOperation,
  sourceDigest,
  sanitizeDiagnostic,
  selectTestManagementTarget,
  repoFile,
} from './lib/integration-io.js';
import {
  loadDotEnv,
  parseCli,
  parseResolutions,
  validateStoryId,
} from './lib/cli.js';

const TARGET = 'testlink';
const SCHEMA = repoFile('schemas/test-cases.schema.json');
const TESTLINK_ID = /^[1-9][0-9]*$/;

// ------------------------------------------------------------ XML-RPC

// Minimal XML-RPC encoding over built-in fetch (no dependency). TestLink
// takes a single struct param of name->value; we only need string/int.
/** @typedef {import('./lib/execution-ledger.js').TestCase} TestCase */
/** @typedef {import('./lib/integration-io.js').SyncRecord} SyncRecord */
/** @typedef {string | number | Record<string, string | number>[]} XmlValue */

/** @param {unknown} s */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
/**
 * @param {XmlValue} value
 * @returns {string}
 */
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
/**
 * @param {string} method
 * @param {Record<string, XmlValue>} struct
 */
function buildCall(method, struct) {
  const members = Object.entries(struct)
    .map(
      ([k, v]) =>
        `<member><name>${k}</name><value>${valueXml(v)}</value></member>`
    )
    .join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params><param><value><struct>${members}</struct></value></param></params></methodCall>`;
}
// Very small XML-RPC response reader: pulls the first <name>X</name> ->
// scalar pairs and any fault string. Enough for the fields we read (id,
// message, code). TestLink returns either a struct or an array of structs.
/**
 * @param {string} xml
 * @returns {Record<string, string>}
 */
function readResponse(xml) {
  if (/<fault>/.test(xml)) {
    const msg = (xml.match(
      /<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/
    ) || [])[1];
    return { fault: msg || 'unknown XML-RPC fault' };
  }
  /** @type {Record<string, string>} */
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
/**
 * tl.createTestCase body -> {id} | {rejected} | null (uninterpretable).
 * @param {string} xml
 */
function parseCreate(xml) {
  if (!/methodResponse/.test(xml)) return null;
  const r = readResponse(xml);
  if (r.fault) return { rejected: `XML-RPC fault: ${r.fault}` };
  if (r.id && TESTLINK_ID.test(r.id)) return { id: r.id };
  if (r.code)
    return { rejected: `TestLink error ${r.code}: ${r.message ?? ''}` };
  return null;
}
/**
 * Every scalar value of <name>field</name> in a response, in order.
 * @param {string} xml
 * @param {string} field
 */
function allValues(xml, field) {
  const re = new RegExp(
    `<name>${field}</name>\\s*<value>\\s*(?:<(?:string|int)>)?([^<]*)`,
    'g'
  );
  return [...xml.matchAll(re)].map((m) => m[1].trim());
}

async function main() {
  loadDotEnv(env, repoFile('.env'));

  const USAGE =
    'Usage: node scripts/sync-to-testlink.js <story-id> [--apply-testlink | --reconcile | --resolve TC-ID=ID|none] [--release-stale-lock]\n' +
    '  Options may come before or after <story-id>.';
  const cli = parseCli(argv.slice(2), {
    usage: USAGE,
    positionals: [{ name: 'story-id', validate: validateStoryId }],
    options: {
      'apply-testlink': { type: 'boolean' },
      reconcile: { type: 'boolean' },
      resolve: { type: 'string', multiple: true },
      'release-stale-lock': { type: 'boolean' },
    },
    exclusive: [['apply-testlink', 'reconcile', 'resolve']],
  });
  if (!cli.ok) {
    console.error(`Error: ${cli.error}`);
    console.error(USAGE);
    return 2;
  }
  const APPLY = cli.values['apply-testlink'] === true;
  const RECONCILE = cli.values.reconcile === true;
  const RELEASE_STALE = cli.values['release-stale-lock'] === true;
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

  const selected = selectTestManagementTarget(env.TEST_MANAGEMENT_TOOL, TARGET);
  if (!selected.ok) {
    console.error(selected.reason);
    return 2;
  }

  const casesPath = `test-cases/${storyId}.json`;
  const mapPath = repoFile('config/testlink-field-map.json');
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

  // --- Validate every input before anything touches TestLink -------------
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

  // --- Plan -----------------------------------------------------------
  const syncStatuses = map.sync_only_status || ['approved'];
  /** @type {TestCase[]} */
  const approved = doc.test_cases.filter((/** @type {TestCase} */ tc) =>
    syncStatuses.includes(tc.status)
  );
  const notApproved = doc.test_cases.length - approved.length;
  if (approved.length === 0) {
    console.log(
      `No cases with status in [${syncStatuses.join(', ')}] in ${casesPath}. Nothing to sync.`
    );
    return 0;
  }

  const importance = map.priority_to_importance || {};
  const execType = map.automation_decision_to_execution_type || {};
  /** @type {(tc: TestCase) => SyncRecord | undefined} */
  const recordOf = (tc) => tc.sync_state?.[TARGET];
  const plan = approved.map((tc) => ({
    tc,
    ...planOperation({
      record: recordOf(tc),
      remoteIds: [tc.testlink_id, tc.external_ids?.[TARGET]],
      isValidId: (/** @type {string} */ id) => TESTLINK_ID.test(id),
    }),
  }));
  const byAction = (/** @type {string} */ a) =>
    plan.filter((p) => p.action === a);
  const suiteName = `${storyId} — ${context.story?.title ?? 'story'}`;
  const caseName = (/** @type {TestCase} */ tc) =>
    `${tc.test_case_id} ${tc.title}`;
  const projectKey = env.TESTLINK_PROJECT_KEY || null;

  console.log(`TestLink sync plan for ${storyId}`);
  console.log(`  Project: ${projectKey ?? '(unset)'}`);
  console.log(`  Test plan id: ${env.TESTLINK_TEST_PLAN_ID ?? '(unset)'}`);
  console.log(`  Suite: ${suiteName}`);
  console.log(`  Approved cases: ${approved.length}`);
  console.log(`  Skipped (not approved): ${notApproved}`);
  for (const p of plan) {
    const { tc } = p;
    /** @type {Record<string, string>} */
    const labels = {
      create: `CREATE, importance=${importance[tc.priority] ?? 2}, exec_type=${execType[tc.automation_decision] ?? 1}`,
      skip: `SKIP (in TestLink as ${p.id}; ${describeSkip(recordOf(tc), sourceDigest(semanticCase(tc)), 'TestLink')})`,
      reconcile: `RECONCILE FIRST (${p.reason})`,
      blocked: `BLOCKED (${p.reason})`,
    };
    const label = labels[p.action];
    console.log(`    - ${tc.test_case_id} "${tc.title}" -> ${label}`);
  }
  console.log(
    `  Create ${byAction('create').length} · skip ${byAction('skip').length} · ` +
      `reconcile ${byAction('reconcile').length} · blocked ${byAction('blocked').length}. ` +
      `Existing TestLink cases are never updated by this adapter.`
  );

  if (!APPLY && !RECONCILE && resolutions.length === 0) {
    console.log(
      '\nDRY RUN (no writes, no local changes). Re-run with --apply-testlink to push to TestLink.'
    );
    return 0;
  }
  if (!projectKey) {
    console.error(
      'TESTLINK_PROJECT_KEY is required to identify the operations.'
    );
    return 2;
  }
  // Set from here on; the nested functions below read this binding.
  const projectPrefix = projectKey;

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

    const url = env.TESTLINK_URL;
    const apiKey = env.TESTLINK_API_KEY;
    if (!url || !apiKey) {
      console.error(
        `${APPLY ? 'Apply' : 'Reconcile'} requires TESTLINK_URL, TESTLINK_API_KEY, and TESTLINK_PROJECT_KEY.`
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
    const secrets = [apiKey];
    const dk = { devKey: apiKey };
    /** @type {(method: string, struct: Record<string, XmlValue>) => ReturnType<typeof httpRequest>} */
    const call = (method, struct) =>
      httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: buildCall(method, struct),
        timeoutMs,
      });
    /**
     * A read (or idempotent) call whose failure aborts the run.
     * @param {string} method
     * @param {Record<string, XmlValue>} struct
     */
    async function read(method, struct) {
      const r = await call(method, struct);
      if (r.kind !== 'response') throw new Error(`${method}: ${r.error}`);
      if (!r.text.includes('methodResponse')) {
        throw new Error(
          `${method}: HTTP ${r.status}: ${sanitizeDiagnostic(r.text, secrets)}`
        );
      }
      return r.text;
    }

    if (RECONCILE) return await reconcile();

    if (byAction('reconcile').length) {
      console.error(
        `\nRefusing to create: ${byAction('reconcile').length} earlier create(s) have an unknown outcome. ` +
          `Run with --reconcile first, so nothing is created twice.`
      );
      return 1;
    }
    const toCreate = byAction('create');
    if (!toCreate.length) {
      console.log('\nNothing to create.');
      return blockedExit();
    }

    const project = await resolveProject();
    console.log(
      `\nResolved project "${project.name}" (prefix ${projectKey}) -> id ${project.id}`
    );
    const suiteId = await ensureSuite(project.id);

    let created = 0;
    for (const { tc } of toCreate) {
      const outcome = await create(tc, project.id, suiteId);
      if (outcome !== 'created') return 1;
      created += 1;
    }
    console.log(
      `\nDone. Created ${created} TestLink case(s); each id was saved to ${casesPath} as it was created.`
    );
    console.log(
      'Note: adding cases to the test plan + the count-verify step ' +
        'use tl.addTestCaseToTestPlan / tl.getTestCasesForTestPlan and can be ' +
        'run as a follow-up; the create + write-back path is complete.'
    );
    return blockedExit();

    // Blocked cases are never touched; they fail the run so a human looks.
    function blockedExit() {
      const n = byAction('blocked').length;
      if (!n) return 0;
      console.error(
        `${n} case(s) are BLOCKED and were not touched; correct them in ${casesPath} (see the plan above).`
      );
      return 1;
    }

    // ------------------------------------------------------------------
    async function resolveProject() {
      // Match on the stable prefix (TESTLINK_PROJECT_KEY): the project's
      // TestLink name differs from the story title.
      const xml = await read('tl.getProjects', dk);
      if (/<fault>/.test(xml)) {
        throw new Error(
          `tl.getProjects faulted: ${sanitizeDiagnostic(xml, secrets)}`
        );
      }
      for (const block of xml.split('<struct>')) {
        const prefix = (block.match(
          /<name>prefix<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
        ) || [])[1];
        if (prefix === projectKey) {
          return {
            id: (block.match(
              /<name>id<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
            ) || [])[1],
            name: (block.match(
              /<name>name<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
            ) || [])[1],
          };
        }
      }
      throw new Error(
        `No TestLink project with prefix "${projectKey}" (TESTLINK_PROJECT_KEY). ` +
          `Check the prefix matches a real project.`
      );
    }

    /** @param {string} projectId */
    async function findSuite(projectId) {
      const xml = await read('tl.getFirstLevelTestSuitesForTestProject', {
        ...dk,
        testprojectid: projectId,
      });
      for (const block of xml.split('<struct>')) {
        const nm = (block.match(
          /<name>name<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
        ) || [])[1];
        if (nm === suiteName) {
          return (block.match(
            /<name>id<\/name>\s*<value>\s*<string>([^<]*)<\/string>/
          ) || [])[1];
        }
      }
      return null;
    }

    // Create the story's suite, or reuse it by name (safe to repeat).
    /** @param {string} projectId */
    async function ensureSuite(projectId) {
      const existing = await findSuite(projectId);
      if (existing) {
        console.log(`Reusing existing suite "${suiteName}" -> id ${existing}`);
        return existing;
      }
      const suite = readResponse(
        await read('tl.createTestSuite', {
          ...dk,
          testprojectid: projectId,
          testsuitename: suiteName,
          details: `Auto-synced from ${casesPath} by scripts/sync-to-testlink.js`,
        })
      );
      if (suite.id && suite.id !== '0') {
        console.log(`Created suite "${suiteName}" -> id ${suite.id}`);
        return suite.id;
      }
      const again = await findSuite(projectId);
      if (again) return again;
      throw new Error(
        `createTestSuite did not return an id and no suite named "${suiteName}" exists: ${sanitizeDiagnostic(JSON.stringify(suite), secrets)}`
      );
    }

    /**
     * @param {TestCase} tc
     * @param {string} projectId
     * @param {string} suiteId
     */
    async function create(tc, projectId, suiteId) {
      const key = operationKey({
        target: TARGET,
        project: projectPrefix,
        storyId,
        localId: tc.test_case_id,
        kind: 'create_case',
      });
      const marker = operationMarker(key);
      const struct = {
        testcasename: caseName(tc),
        testsuiteid: suiteId,
        testprojectid: projectId,
        authorlogin: 'admin',
        // The marker lets --reconcile recognise this exact create later.
        summary: `${tc.description}<br/><br/>${marker}`,
        preconditions: (tc.preconditions || []).join('<br/>'),
        importance: importance[tc.priority] ?? 2,
        executiontype: execType[tc.automation_decision] ?? 1,
        steps: (tc.steps || []).map(
          (/** @type {any} */ s, /** @type {number} */ i) => ({
            step_number: i + 1,
            actions:
              s.action + (s.data ? ` (data: ${JSON.stringify(s.data)})` : ''),
            expected_results: (tc.expected_results || []).join('<br/>'),
            execution_type: execType[tc.automation_decision] ?? 1,
          })
        ),
      };
      /** @type {SyncRecord} */
      const record = {
        operation_key: key,
        marker,
        marker_searchable: true,
        payload_digest: payloadDigest(struct),
        source_digest: sourceDigest(semanticCase(tc)),
        state: SYNC_STATE.PENDING,
        intent_at: now(),
        updated_at: now(),
        link_state: 'not_applicable',
      };
      tc.sync_state = { ...tc.sync_state, [TARGET]: record };
      const saved = persist();
      if (!saved.ok) {
        console.error(
          `${tc.test_case_id}: could not save the intent before creating (${saved.message}). Nothing was sent.`
        );
        return 'aborted';
      }

      const out = classifyCreate(
        await call('tl.createTestCase', { ...dk, ...struct }),
        parseCreate,
        secrets
      );

      if (out.outcome === 'created') {
        tc.testlink_id = out.id;
        tc.external_ids = { ...tc.external_ids, [TARGET]: out.id };
        Object.assign(record, {
          state: SYNC_STATE.CREATED,
          remote_id: out.id,
          created_at: now(),
          updated_at: now(),
        });
        const kept = persist();
        if (!kept.ok) {
          console.error(
            `\nCRITICAL: TestLink created case ${out.id} for ${tc.test_case_id}, but it could not be saved (${kept.message}).\n` +
              `Record it before doing anything else:\n` +
              `  node scripts/sync-to-testlink.js ${storyId} --resolve ${tc.test_case_id}=${out.id}`
          );
          return 'aborted';
        }
        console.log(`  ${tc.test_case_id} -> TestLink id ${out.id}`);
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
          `${tc.test_case_id}: TestLink rejected the create (${out.detail}). Nothing was created.` +
            (kept.ok ? '' : ` (Could not record the failure: ${kept.message}.)`)
        );
        return 'rejected';
      }

      record.last_error = out.detail.slice(0, 500);
      record.updated_at = now();
      const kept = persist();
      console.error(
        `${tc.test_case_id}: the outcome of the create is unknown (${out.detail}).\n` +
          `It may exist in TestLink. Stopped before any other create. Run:\n` +
          `  node scripts/sync-to-testlink.js ${storyId} --reconcile` +
          (kept.ok
            ? ''
            : `\n(Could not record the diagnostic: ${kept.message}; the pending intent was saved earlier.)`)
      );
      return 'ambiguous';
    }

    // Read-only: find a pending create by name in the story's suite, and
    // accept a candidate only if its summary carries the operation marker.
    async function reconcile() {
      const pending = byAction('reconcile');
      if (!pending.length) {
        console.log('\nNothing to reconcile.');
        return 0;
      }
      const project = await resolveProject();
      const suiteExists = Boolean(await findSuite(project.id));
      let unresolved = 0;
      for (const { tc } of pending) {
        // A pending operation always has its record (planOperation).
        const record = /** @type {SyncRecord} */ (recordOf(tc));
        /** @type {string[]} */
        let matches = [];
        if (suiteExists) {
          const xml = await read('tl.getTestCaseIDByName', {
            ...dk,
            testcasename: caseName(tc),
            testsuitename: suiteName,
            testprojectname: project.name,
          });
          const r = readResponse(xml);
          if (r.fault) {
            unresolved += 1;
            console.error(
              `  ${tc.test_case_id}: search faulted (${sanitizeDiagnostic(r.fault, secrets)}); still pending.`
            );
            continue;
          }
          // An error struct (e.g. "no test case with this name") means none.
          const ids = r.code && !r.id ? [] : allValues(xml, 'id');
          for (const id of ids.filter((i) => TESTLINK_ID.test(i))) {
            const detail = await read('tl.getTestCase', {
              ...dk,
              testcaseid: id,
            });
            if (detail.includes(record.marker)) matches.push(id);
          }
          matches = [...new Set(matches)];
        }
        if (matches.length > 1) {
          unresolved += 1;
          console.error(
            `  ${tc.test_case_id}: ${matches.length} cases carry ${record.marker} (${matches.join(', ')}). ` +
              `Decide which one is the test case, then --resolve ${tc.test_case_id}=<ID>.`
          );
          continue;
        }
        if (matches.length === 1) {
          adopt(tc, matches[0]);
          console.log(
            `  ${tc.test_case_id} -> found TestLink id ${matches[0]} (created earlier)`
          );
        } else {
          markNotFound(tc);
          console.log(
            `  ${tc.test_case_id} -> not in TestLink; it will be created on the next --apply-testlink`
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
        if (remote !== null && !TESTLINK_ID.test(remote)) {
          console.error(
            `--resolve: "${remote}" is not a TestLink test case id.`
          );
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
      tc.testlink_id = remote;
      tc.external_ids = { ...tc.external_ids, [TARGET]: remote };
      // Callers adopt only a case with a pending record.
      const record = /** @type {SyncRecord} */ (recordOf(tc));
      Object.assign(record, {
        state: SYNC_STATE.CREATED,
        remote_id: remote,
        reconciled_at: now(),
        updated_at: now(),
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
}

main().then(
  (code) => exit(code),
  (e) => {
    console.error(`\nTestLink sync FAILED: ${e.message}`);
    exit(1);
  }
);
