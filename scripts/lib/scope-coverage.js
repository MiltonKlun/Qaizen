// @ts-check
// Does the test scope cover the story? (Gate 2 and the lite consolidated gate)
//
// Every acceptance criterion should be referenced by at least one case, and
// every risk should be addressed by at least one case. A case the reviewer
// rejected does not count. A `skip` case counts: it is the written, reviewed
// decision not to test something (its automation_decision_reason says why),
// which is how a risk is accepted without a test. A criterion or risk that
// only `skip` cases cover is named, so the reviewer sees it was accepted, not
// tested; one that only `manual` (and `skip`) cases cover is named too, so
// the reviewer sees no automated test checks it.
//
// A case that references a criterion or risk the context does not have is a
// broken traceability link (CLAUDE.md §3.4): it is named, and Gate 2's input
// check refuses the gate until it is fixed.
//
// The check is mechanical; whether the cases are the RIGHT ones stays the
// reviewer's judgment. `config/gate-checks.json` decides what a coverage gap
// does: `warn` (the default) names it in the brief, `block` keeps the gate
// closed until the scope covers the story.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What a coverage gap does at the gate. */
export const COVERAGE_MODES = ['warn', 'block'];

/**
 * @typedef {{ test_case_id: string, status?: string,
 *   automation_decision?: string, risk_ids?: string[],
 *   acceptance_criteria_refs?: number[] }} ScopeCase
 * @typedef {{ uncoveredAcs: number[], uncoveredRisks: string[],
 *   skipOnlyAcs: number[], skipOnlyRisks: string[],
 *   manualOnlyAcs: number[], manualOnlyRisks: string[],
 *   unknownRefs: string[], acs: number, risks: number }} ScopeCoverage
 */

/**
 * @param {{ acceptance_criteria?: string[], risks?: { risk_id: string }[] }} context
 * @param {{ test_cases?: ScopeCase[] } | null | undefined} doc
 * @returns {ScopeCoverage} criteria are numbered from 1, as the story shows them
 */
export function scopeCoverage(context, doc) {
  const cases = (doc?.test_cases ?? []).filter((c) => c.status !== 'rejected');
  const acs = context?.acceptance_criteria ?? [];
  const risks = context?.risks ?? [];
  /** @type {(mine: ScopeCase[]) => 'none' | 'skip' | 'manual' | 'automated'} */
  const reach = (mine) =>
    !mine.length
      ? 'none'
      : mine.every((c) => c.automation_decision === 'skip')
        ? 'skip'
        : mine.every(
              (c) =>
                c.automation_decision === 'skip' ||
                c.automation_decision === 'manual'
            )
          ? 'manual'
          : 'automated';
  const cov = {
    uncoveredAcs: /** @type {number[]} */ ([]),
    uncoveredRisks: /** @type {string[]} */ ([]),
    skipOnlyAcs: /** @type {number[]} */ ([]),
    skipOnlyRisks: /** @type {string[]} */ ([]),
    manualOnlyAcs: /** @type {number[]} */ ([]),
    manualOnlyRisks: /** @type {string[]} */ ([]),
    unknownRefs: /** @type {string[]} */ ([]),
    acs: acs.length,
    risks: risks.length,
  };
  acs.forEach((_, i) => {
    const r = reach(
      cases.filter((c) => (c.acceptance_criteria_refs ?? []).includes(i))
    );
    if (r === 'none') cov.uncoveredAcs.push(i + 1);
    else if (r === 'skip') cov.skipOnlyAcs.push(i + 1);
    else if (r === 'manual') cov.manualOnlyAcs.push(i + 1);
  });
  for (const risk of risks) {
    const r = reach(
      cases.filter((c) => (c.risk_ids ?? []).includes(risk.risk_id))
    );
    if (r === 'none') cov.uncoveredRisks.push(risk.risk_id);
    else if (r === 'skip') cov.skipOnlyRisks.push(risk.risk_id);
    else if (r === 'manual') cov.manualOnlyRisks.push(risk.risk_id);
  }
  const riskIds = new Set(risks.map((r) => r.risk_id));
  for (const c of cases) {
    for (const ref of c.acceptance_criteria_refs ?? [])
      if (!Number.isInteger(ref) || ref < 0 || ref >= acs.length)
        cov.unknownRefs.push(`${c.test_case_id} → AC ${ref + 1}`);
    for (const id of c.risk_ids ?? [])
      if (!riskIds.has(id)) cov.unknownRefs.push(`${c.test_case_id} → ${id}`);
  }
  return cov;
}

/**
 * The references to nothing, in one sentence; empty when every reference
 * resolves. Gate 2's input check refuses the gate on this, in any mode.
 * @param {ScopeCoverage} cov
 * @returns {string}
 */
export function referenceErrors(cov) {
  if (!cov.unknownRefs.length) return '';
  return `${cov.unknownRefs.join(', ')}: ${cov.unknownRefs.length === 1 ? 'a case references a criterion or risk' : 'cases reference criteria or risks'} the context does not have (acceptance_criteria_refs count from 0)`;
}

/**
 * The gaps, in one sentence; empty when the scope covers the story.
 * @param {ScopeCoverage} cov
 * @returns {string}
 */
export function coverageGaps(cov) {
  const parts = [
    ...cov.uncoveredAcs.map((n) => `AC ${n}`),
    ...cov.uncoveredRisks,
  ];
  if (!parts.length) return '';
  return `${parts.join(', ')} ${parts.length === 1 ? 'has' : 'have'} no approved test case`;
}

/**
 * The line the gate brief shows.
 * @param {ScopeCoverage} cov
 * @returns {string}
 */
export function coverageLine(cov) {
  const refs = referenceErrors(cov);
  const gaps = coverageGaps(cov);
  /** @type {(items: (number | string)[], what: string) => string} */
  const named = (items, what) =>
    items.length
      ? `; ${items.map((x) => (typeof x === 'number' ? `AC ${x}` : x)).join(', ')} ${items.length === 1 ? 'is' : 'are'} ${what}`
      : '';
  const notes =
    named(
      [...cov.skipOnlyAcs, ...cov.skipOnlyRisks],
      'accepted without a test (only skip cases)'
    ) +
    named(
      [...cov.manualOnlyAcs, ...cov.manualOnlyRisks],
      'tested only by hand (only manual or skip cases)'
    );
  if (refs || gaps)
    return `ATTENTION: ${[refs, gaps].filter(Boolean).join('; ')}${notes}`;
  return `every acceptance criterion (${cov.acs}) and risk (${cov.risks}) has at least one approved case${notes}`;
}

/**
 * What a coverage gap does, from config/gate-checks.json (`warn` when the file
 * or the setting is absent). An unknown value is an error, never a silent
 * default.
 * @param {string} [root] the repository
 * @returns {{ ok: true, mode: 'warn' | 'block' } | { ok: false, message: string }}
 */
export function coverageMode(root = REPO_DIR) {
  const path = join(root, 'config', 'gate-checks.json');
  if (!existsSync(path)) return { ok: true, mode: 'warn' };
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')).scope_coverage;
  } catch (e) {
    return {
      ok: false,
      message: `config/gate-checks.json is not valid JSON: ${/** @type {Error} */ (e).message}`,
    };
  }
  if (value === undefined) return { ok: true, mode: 'warn' };
  if (!COVERAGE_MODES.includes(value)) {
    return {
      ok: false,
      message: `config/gate-checks.json scope_coverage is "${value}"; use "warn" or "block".`,
    };
  }
  return { ok: true, mode: /** @type {'warn' | 'block'} */ (value) };
}
