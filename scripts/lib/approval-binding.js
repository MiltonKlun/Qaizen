// @ts-check
// Bind each human approval to the exact inputs it reviewed (task group 4.3).
//
// A gate used to be a boolean (or an audit object with `status: true`). Once
// approved, it stayed approved no matter what changed afterwards: edit an
// expected value after Gate 2, rewrite the story after Gate 1, bump a
// dependency after Gate 4 — the approval still read as current. This module
// records, AT APPROVAL, a SHA-256 over what the reviewer was shown, and later
// tells whether that is still what exists.
//
//   Gate 1 (requirements_reviewed) = story + the interpreted ACs, risks,
//                                    ambiguities and track
//   Gate 2 (test_scope_reviewed)   = Gate-1 digest + semantic test cases
//                                    + planner brief
//   Gate 3 (specs_reviewed)        = Gate-2 digest + spec + planner/generator
//                                    prompt versions
//   Gate 4 (code_reviewed)         = Gate-3 digest + generated test + fixtures
//                                    + Playwright config + dependency lock
//   qa_scope_approved (lite)       = the union of Gate-1 and Gate-2 inputs
//   external_plan_reviewed         = Gate-2 digest + external plan
//   external_evidence_reviewed     = external-plan digest + imported results
//                                    + the evidence files they cite
//
// Chaining the digests means a change upstream makes every later approval
// stale on its own. The digest never covers the approval object itself,
// timestamps, or integration ids written back by adapters (a Jira id added
// to a test case is not a change to what was approved).
//
// Pure computation over files and context. Recording and invalidating are
// the runner's job; this only answers "what is the digest now?" and "which
// approvals no longer match?".

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Gates that are bound, in pipeline order. */
export const BOUND_GATES = [
  'requirements_reviewed',
  'test_scope_reviewed',
  'qa_scope_approved',
  'specs_reviewed',
  'code_reviewed',
  'collection_reviewed',
  'api_assertions_reviewed',
  'external_plan_reviewed',
  'external_evidence_reviewed',
];

/**
 * Approvals that stop meaning anything when a gate becomes stale. The lite
 * consolidated gate stands for Gates 1+2, so either side invalidates the other.
 */
/** @type {Record<string, string[]>} */
export const DOWNSTREAM = {
  requirements_reviewed: [
    'test_scope_reviewed',
    'qa_scope_approved',
    'specs_reviewed',
    'code_reviewed',
    'collection_reviewed',
    'api_assertions_reviewed',
    'external_plan_reviewed',
    'external_evidence_reviewed',
  ],
  test_scope_reviewed: [
    'qa_scope_approved',
    'specs_reviewed',
    'code_reviewed',
    'collection_reviewed',
    'api_assertions_reviewed',
    'external_plan_reviewed',
    'external_evidence_reviewed',
  ],
  qa_scope_approved: [
    'requirements_reviewed',
    'test_scope_reviewed',
    'specs_reviewed',
    'code_reviewed',
    'collection_reviewed',
    'api_assertions_reviewed',
    'external_plan_reviewed',
    'external_evidence_reviewed',
  ],
  specs_reviewed: ['code_reviewed'],
  code_reviewed: [],
  // The API branch is reviewed on its own track: requests, then assertions.
  collection_reviewed: ['api_assertions_reviewed'],
  api_assertions_reviewed: [],
  // Manual, component and skip cases (task group 7.2): plan, then evidence.
  external_plan_reviewed: ['external_evidence_reviewed'],
  external_evidence_reviewed: [],
};

/**
 * The run's parsed context.json (schemas/context.schema.json). Read loosely:
 * every access here tolerates an absent field.
 * @typedef {Record<string, any>} Context
 */
/**
 * How one approval stands against today's inputs.
 * @typedef {{ state: 'pending' } | { state: 'legacy' } | { state: 'current' }
 *   | { state: 'stale', changed: string[], current_digest: string }} BindingState
 */
/**
 * @typedef {{ gate: string, reason: string, approved_digest: string | null,
 *   current_digest: string | null, changed_inputs: string[] }} Invalidation
 */

/**
 * The story's Postman collection and environment (conventional paths).
 * @param {Context | null | undefined} context
 */
export function apiPaths(context) {
  const paths = context?.artifact_paths ?? {};
  const id = context?.story?.id ?? '<story>';
  return {
    collection:
      paths.api_collection ||
      `api-tests/collections/${id}.postman_collection.json`,
    environment:
      paths.api_environment ||
      `api-tests/environments/${id}.postman_environment.json`,
  };
}

/**
 * The story's external plan and imported results (conventional paths).
 * @param {Context | null | undefined} context
 */
export function externalPaths(context) {
  const paths = context?.artifact_paths ?? {};
  const id = context?.story?.id ?? '<story>';
  return {
    plan: paths.external_plan || `planner-input/${id}.external-plan.json`,
    results: paths.external_results || `external-evidence/${id}.results.json`,
  };
}

/**
 * The evidence files the imported results cite, each by its CURRENT bytes: a
 * screenshot replaced after review is a different input (null = missing).
 * @param {string} root
 * @param {string} rel
 * @returns {Record<string, string | null>}
 */
function evidenceDigests(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return {};
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return {};
  }
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const r of Array.isArray(doc?.results) ? doc.results : []) {
    for (const e of Array.isArray(r?.evidence) ? r.evidence : []) {
      if (typeof e?.path !== 'string') continue;
      const f = join(root, e.path);
      out[`evidence:${e.path}`] =
        existsSync(f) && statSync(f).isFile() ? sha256(readFileSync(f)) : null;
    }
  }
  return out;
}

/**
 * Every item of a collection, with its folder path, depth first.
 * @param {any[] | undefined} items
 * @param {string[]} [path]
 * @returns {{ path: string, item: any }[]}
 */
function collectionItems(items, path = []) {
  /** @type {{ path: string, item: any }[]} */
  const out = [];
  for (const it of items ?? []) {
    const here = [...path, it?.name ?? ''];
    out.push({ path: here.join(' / '), item: it });
    if (Array.isArray(it?.item)) out.push(...collectionItems(it.item, here));
  }
  return out;
}

const isTestEvent = (/** @type {any} */ e) => e?.listen === 'test';

/**
 * What Gate 3' reviews: the requests and variables, without the assertion
 * scripts (those are Gate 4'). Pre-request scripts stay: they shape requests.
 * @param {any} col parsed Postman collection
 */
function collectionRequests(col) {
  /** @type {(node: any) => any} */
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        k === 'event' && Array.isArray(v)
          ? v.filter((e) => !isTestEvent(e)).map(strip)
          : strip(v);
    }
    return out;
  };
  return strip(col);
}

/**
 * What Gate 4' reviews: every assertion script, by where it runs.
 * @param {any} col parsed Postman collection
 */
function collectionAssertions(col) {
  /** @type {{ where: string, exec: string }[]} */
  const scripts = [];
  const add = (/** @type {string} */ where, /** @type {any[]} */ events) => {
    for (const e of (events ?? []).filter(isTestEvent)) {
      const exec = e.script?.exec;
      scripts.push({
        where,
        exec: Array.isArray(exec) ? exec.join('\n') : String(exec ?? ''),
      });
    }
  };
  add('(collection)', col?.event);
  for (const { path, item } of collectionItems(col?.item))
    add(path, item?.event);
  return scripts;
}

/**
 * The environment's keys with their values replaced by placeholders: the
 * approval binds to WHICH variables exist, never to secret values.
 * @param {any} env parsed Postman environment
 */
function environmentShape(env) {
  return (env?.values ?? [])
    .map((/** @type {any} */ v) => ({
      key: v?.key ?? null,
      enabled: v?.enabled !== false,
      value: /^\{\{.*\}\}$/.test(String(v?.value ?? '')) ? v.value : '<value>',
    }))
    .sort(
      (/** @type {{ key: unknown }} */ a, /** @type {{ key: unknown }} */ b) =>
        String(a.key).localeCompare(String(b.key))
    );
}

/**
 * @param {string} root
 * @param {string | undefined} rel
 * @param {(parsed: any) => unknown} view
 */
function jsonFileView(root, rel, view) {
  const abs = rel ? join(root, rel) : null;
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null;
  try {
    return sha256(canonicalJson(view(JSON.parse(readFileSync(abs, 'utf8')))));
  } catch {
    return textDigest(readFileSync(abs));
  }
}

/**
 * Test-case fields adapters write back after a sync. They record WHERE a case
 * was pushed, not WHAT it says, so they never invalidate an approval.
 * Everything else — expected results, automation decisions, priorities, and
 * the per-case approval status — is part of what was approved.
 */
const TC_WRITEBACK_FIELDS = [
  'testlink_id',
  'external_ids',
  'sync_state',
  'qmetry_fields',
];

const sha256 = (/** @type {string | Buffer} */ s) =>
  createHash('sha256').update(s).digest('hex');

/**
 * Deterministic JSON: object keys sorted at every depth, no whitespace.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Text digest with line endings normalized: the same file checked out on
 * Windows (CRLF) and Linux (LF) must not look like a different review input.
 * @param {Buffer} buf
 */
function textDigest(buf) {
  return sha256(buf.toString('utf8').replace(/\r\n/g, '\n'));
}

/**
 * A file's digest, or null when it does not exist. JSON is canonicalized.
 * @param {string} root
 * @param {string | undefined | null} rel
 * @param {{ json?: boolean, strip?: ((parsed: any) => unknown) | null }} [opts]
 * @returns {string | null}
 */
function fileDigest(root, rel, { json = false, strip = null } = {}) {
  if (!rel) return null;
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const buf = readFileSync(abs);
  if (!json) return textDigest(buf);
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return sha256(canonicalJson(strip ? strip(parsed) : parsed));
  } catch {
    // Not JSON after all: the bytes are still what was reviewed.
    return textDigest(buf);
  }
}

/**
 * A test case without the linkage fields adapters write back.
 * @param {Record<string, any>} tc
 */
export function semanticCase(tc) {
  const copy = { ...tc };
  for (const k of TC_WRITEBACK_FIELDS) delete copy[k];
  return copy;
}

/**
 * The semantic content of a test-cases file: writeback ids removed.
 * @param {any} doc parsed test-cases file
 */
function semanticTestCases(doc) {
  return {
    ...doc,
    test_cases: (doc.test_cases ?? []).map(semanticCase),
  };
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(root, child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/**
 * The named inputs a gate reviews, each reduced to a digest (null = absent).
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 * @returns {Record<string, string|null>}
 */
export function gateInputs(gate, context, root = '.') {
  const paths = context?.artifact_paths ?? {};
  const g1 = () => ({
    story: fileDigest(root, context?.story?.path || 'story.md'),
    interpretation: sha256(
      canonicalJson({
        acceptance_criteria: context?.acceptance_criteria ?? [],
        risks: context?.risks ?? [],
        ambiguities: context?.ambiguities ?? [],
        track: context?.track ?? null,
      })
    ),
  });
  const scope = () => ({
    test_cases: fileDigest(root, paths.test_cases, {
      json: true,
      strip: semanticTestCases,
    }),
    planner_brief: fileDigest(root, paths.planner_brief),
  });

  switch (gate) {
    case 'requirements_reviewed':
      return g1();
    case 'test_scope_reviewed':
      return {
        'gate:requirements_reviewed': gateDigest(
          'requirements_reviewed',
          context,
          root
        ),
        ...scope(),
      };
    case 'qa_scope_approved':
      return { ...g1(), ...scope() };
    case 'specs_reviewed': {
      const versions = Object.fromEntries(
        Object.entries(context?.prompt_versions ?? {}).filter(([k]) =>
          /planner|generator/i.test(k)
        )
      );
      return {
        'gate:test_scope_reviewed': gateDigest(
          'test_scope_reviewed',
          context,
          root
        ),
        playwright_spec: fileDigest(root, paths.playwright_spec),
        prompt_versions: sha256(canonicalJson(versions)),
      };
    }
    case 'code_reviewed': {
      /** @type {Record<string, string | null>} */
      const inputs = {
        'gate:specs_reviewed': gateDigest('specs_reviewed', context, root),
        generated_test: fileDigest(root, paths.generated_test),
        'playwright.config.ts': fileDigest(root, 'playwright.config.ts'),
        'package-lock.json': fileDigest(root, 'package-lock.json', {
          json: true,
        }),
      };
      for (const f of walk(root, 'tests/fixtures').sort()) {
        inputs[f] = fileDigest(root, f);
      }
      return inputs;
    }
    case 'collection_reviewed': {
      const api = apiPaths(context);
      return {
        'gate:test_scope_reviewed': gateDigest(
          'test_scope_reviewed',
          context,
          root
        ),
        api_requests: jsonFileView(root, api.collection, collectionRequests),
        api_environment: jsonFileView(root, api.environment, environmentShape),
        endpoint_contract: fileDigest(root, 'docs/api-spec.yaml'),
      };
    }
    case 'api_assertions_reviewed': {
      const api = apiPaths(context);
      return {
        'gate:collection_reviewed': gateDigest(
          'collection_reviewed',
          context,
          root
        ),
        api_assertions: jsonFileView(
          root,
          api.collection,
          collectionAssertions
        ),
        'scripts/run-newman.js': fileDigest(root, 'scripts/run-newman.js'),
        'package-lock.json': fileDigest(root, 'package-lock.json', {
          json: true,
        }),
      };
    }
    case 'external_plan_reviewed':
      return {
        'gate:test_scope_reviewed': gateDigest(
          'test_scope_reviewed',
          context,
          root
        ),
        external_plan: fileDigest(root, externalPaths(context).plan, {
          json: true,
        }),
      };
    case 'external_evidence_reviewed': {
      const ext = externalPaths(context);
      return {
        'gate:external_plan_reviewed': gateDigest(
          'external_plan_reviewed',
          context,
          root
        ),
        external_results: fileDigest(root, ext.results, { json: true }),
        ...evidenceDigests(root, ext.results),
      };
    }
    default:
      throw new Error(`gateInputs: unknown gate "${gate}"`);
  }
}

/**
 * One file a gate's approval covers, for snapshots and restores (gate
 * records). `copy: false` marks a repository file (the lockfile, the Newman
 * script) whose digest is recorded but whose bytes are not the run's.
 * @typedef {{ input: string, path: string, copy: boolean }} GateFile
 */

/**
 * The files behind a gate's own inputs: the same list `gateInputs` digests,
 * without the chained digest of the previous gate. Gate 1's interpretation
 * and Gate 3's prompt versions live in context.json, so it stands for them.
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 * @returns {GateFile[]}
 */
export function gateFiles(gate, context, root = '.') {
  const paths = context?.artifact_paths ?? {};
  /** @type {(input: string, path: string | undefined | null, copy?: boolean) => GateFile[]} */
  const f = (input, path, copy = true) => (path ? [{ input, path, copy }] : []);
  const g1 = () => [
    ...f('story', context?.story?.path || 'story.md'),
    ...f('interpretation', 'context.json'),
  ];
  const scope = () => [
    ...f('test_cases', paths.test_cases),
    ...f('planner_brief', paths.planner_brief),
  ];
  switch (gate) {
    case 'requirements_reviewed':
      return g1();
    case 'test_scope_reviewed':
      return scope();
    case 'qa_scope_approved':
      return [...g1(), ...scope()];
    case 'specs_reviewed':
      return [
        ...f('playwright_spec', paths.playwright_spec),
        ...f('prompt_versions', 'context.json'),
      ];
    case 'code_reviewed':
      return [
        ...f('generated_test', paths.generated_test),
        ...f('playwright.config.ts', 'playwright.config.ts'),
        ...f('package-lock.json', 'package-lock.json', false),
        ...walk(root, 'tests/fixtures')
          .sort()
          .flatMap((p) => f(p, p)),
      ];
    case 'collection_reviewed': {
      const api = apiPaths(context);
      return [
        ...f('api_requests', api.collection),
        ...f('api_environment', api.environment),
        ...f('endpoint_contract', 'docs/api-spec.yaml', false),
      ];
    }
    case 'api_assertions_reviewed':
      return [
        ...f('api_assertions', apiPaths(context).collection),
        ...f('scripts/run-newman.js', 'scripts/run-newman.js', false),
        ...f('package-lock.json', 'package-lock.json', false),
      ];
    case 'external_plan_reviewed':
      return f('external_plan', externalPaths(context).plan);
    case 'external_evidence_reviewed': {
      const ext = externalPaths(context);
      return [
        ...f('external_results', ext.results),
        ...Object.keys(evidenceDigests(root, ext.results)).flatMap((k) =>
          f(k, k.slice('evidence:'.length))
        ),
      ];
    }
    default:
      throw new Error(`gateFiles: unknown gate "${gate}"`);
  }
}

/**
 * The aggregate digest a gate's approval is bound to: inputs + run identity.
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 * @returns {string}
 */
export function gateDigest(gate, context, root = '.') {
  const inputs = gateInputs(gate, context, root);
  return sha256(
    canonicalJson({
      gate,
      run_id: context?.run_id ?? null,
      story_id: context?.story?.id ?? null,
      inputs,
    })
  );
}

/**
 * What to store on the gate value at the moment of human approval.
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 */
export function bindingFor(gate, context, root = '.') {
  return {
    input_digest: gateDigest(gate, context, root),
    inputs: gateInputs(gate, context, root),
  };
}

const passed = (/** @type {any} */ v) =>
  v === true || (v && typeof v === 'object' && v.status === true);

/**
 * How one approval stands against today's inputs.
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 * @returns {BindingState}
 */
export function bindingState(gate, context, root = '.') {
  const value = context?.review_gates?.[gate];
  if (!passed(value)) return { state: 'pending' };
  if (value === true || !value.input_digest) return { state: 'legacy' };
  const current = gateDigest(gate, context, root);
  if (current === value.input_digest) return { state: 'current' };
  const now = gateInputs(gate, context, root);
  const was = value.inputs ?? {};
  const changed = [...new Set([...Object.keys(now), ...Object.keys(was)])]
    .filter((k) => now[k] !== was[k])
    .sort();
  return { state: 'stale', changed, current_digest: current };
}

/**
 * Every approval that no longer stands, with the reason, including the
 * downstream approvals that depended on it. Nothing is written here.
 *
 * @param {Context} context
 * @param {string} [root]
 * @returns {Invalidation[]}
 */
export function findInvalidations(context, root = '.') {
  /** @type {Map<string, Invalidation>} */
  const out = new Map();
  const add = (
    /** @type {string} */ gate,
    /** @type {Invalidation} */ entry
  ) => {
    if (!out.has(gate)) out.set(gate, entry);
  };
  for (const gate of BOUND_GATES) {
    const s = bindingState(gate, context, root);
    if (s.state !== 'stale' && s.state !== 'legacy') continue;
    const value = context.review_gates[gate];
    add(gate, {
      gate,
      reason:
        s.state === 'legacy'
          ? 'approved before approvals were bound to their reviewed inputs; needs re-review'
          : `reviewed inputs changed since approval: ${s.changed.join(', ')}`,
      approved_digest:
        typeof value === 'object' ? (value.input_digest ?? null) : null,
      current_digest:
        s.state === 'stale'
          ? s.current_digest
          : gateDigest(gate, context, root),
      changed_inputs: s.state === 'stale' ? s.changed : [],
    });
    for (const d of DOWNSTREAM[gate]) {
      if (!passed(context.review_gates?.[d])) continue;
      const dv = context.review_gates[d];
      add(d, {
        gate: d,
        reason: `depends on ${gate}, which is no longer approved`,
        approved_digest:
          typeof dv === 'object' ? (dv.input_digest ?? null) : null,
        current_digest: gateDigest(d, context, root),
        changed_inputs: [],
      });
    }
  }
  return [...out.values()];
}

/**
 * Apply invalidations to a context (in memory): the gate returns to pending
 * and a separate invalidation event records why. No rejection is invented and
 * gate_decisions[] — the human history — is left exactly as it was.
 * @param {Context} context
 * @param {Invalidation[]} invalidations
 * @param {Date} [now]
 */
export function applyInvalidations(context, invalidations, now = new Date()) {
  if (!invalidations.length) return context;
  if (!Array.isArray(context.gate_invalidations))
    context.gate_invalidations = [];
  for (const inv of invalidations) {
    const prev = context.review_gates[inv.gate];
    context.review_gates[inv.gate] = {
      status: false,
      reviewer: null,
      reviewed_at: null,
      opened_at: null,
      notes: null,
    };
    context.gate_invalidations.push({
      gate: inv.gate,
      invalidated_at: now.toISOString(),
      reason: inv.reason,
      approved_digest: inv.approved_digest,
      current_digest: inv.current_digest,
      changed_inputs: inv.changed_inputs,
      previous_reviewer:
        typeof prev === 'object' ? (prev.reviewer ?? null) : null,
      previous_reviewed_at:
        typeof prev === 'object' ? (prev.reviewed_at ?? null) : null,
    });
  }
  return context;
}

/**
 * For entry points outside the runner (classifier, TestLink/Jira adapters):
 * is this gate approved AND still bound to what exists? Never mutates.
 * @param {Context} context
 * @param {string} gate
 * @param {string} [root]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function requireCurrentGate(context, gate, root = '.') {
  const s = bindingState(gate, context, root);
  if (s.state === 'current') return { ok: true };
  if (s.state === 'pending')
    return { ok: false, reason: `${gate} is not approved` };
  if (s.state === 'legacy') {
    return {
      ok: false,
      reason: `${gate} was approved before approvals were bound to their inputs; re-review it (npm run pipeline)`,
    };
  }
  return {
    ok: false,
    reason: `${gate} is stale: ${s.changed.join(', ')} changed since it was approved; re-review it (npm run pipeline)`,
  };
}

export const __testing = { TC_WRITEBACK_FIELDS, DOWNSTREAM };
