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
];

/**
 * Approvals that stop meaning anything when a gate becomes stale. The lite
 * consolidated gate stands for Gates 1+2, so either side invalidates the other.
 */
const DOWNSTREAM = {
  requirements_reviewed: [
    'test_scope_reviewed',
    'qa_scope_approved',
    'specs_reviewed',
    'code_reviewed',
  ],
  test_scope_reviewed: ['qa_scope_approved', 'specs_reviewed', 'code_reviewed'],
  qa_scope_approved: [
    'requirements_reviewed',
    'test_scope_reviewed',
    'specs_reviewed',
    'code_reviewed',
  ],
  specs_reviewed: ['code_reviewed'],
  code_reviewed: [],
};

/**
 * Test-case fields adapters write back after a sync. They record WHERE a case
 * was pushed, not WHAT it says, so they never invalidate an approval.
 * Everything else — expected results, automation decisions, priorities, and
 * the per-case approval status — is part of what was approved.
 */
const TC_WRITEBACK_FIELDS = ['testlink_id', 'external_ids', 'qmetry_fields'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: object keys sorted at every depth, no whitespace. */
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
 */
function textDigest(buf) {
  return sha256(buf.toString('utf8').replace(/\r\n/g, '\n'));
}

/** A file's digest, or null when it does not exist. JSON is canonicalized. */
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

/** The semantic content of a test-cases file: writeback ids removed. */
function semanticTestCases(doc) {
  return {
    ...doc,
    test_cases: (doc.test_cases ?? []).map((tc) => {
      const copy = { ...tc };
      for (const k of TC_WRITEBACK_FIELDS) delete copy[k];
      return copy;
    }),
  };
}

function walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
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
    default:
      throw new Error(`gateInputs: unknown gate "${gate}"`);
  }
}

/** The aggregate digest a gate's approval is bound to: inputs + run identity. */
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

/** What to store on the gate value at the moment of human approval. */
export function bindingFor(gate, context, root = '.') {
  return {
    input_digest: gateDigest(gate, context, root),
    inputs: gateInputs(gate, context, root),
  };
}

const passed = (v) =>
  v === true || (v && typeof v === 'object' && v.status === true);

/**
 * How one approval stands against today's inputs.
 * @returns {{state: 'pending'|'current'|'stale'|'legacy', changed?: string[],
 *            current_digest?: string}}
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
 * @returns {Array<{gate: string, reason: string, approved_digest: string|null,
 *                  current_digest: string|null, changed_inputs: string[]}>}
 */
export function findInvalidations(context, root = '.') {
  const out = new Map();
  const add = (gate, entry) => {
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
      current_digest: s.current_digest ?? gateDigest(gate, context, root),
      changed_inputs: s.changed ?? [],
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
