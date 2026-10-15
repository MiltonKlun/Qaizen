// @ts-check
// Does the test scope cover the story? (Gate 2 and the lite consolidated gate)
//
// Every acceptance criterion should be referenced by at least one case, and
// every risk should be addressed by at least one case. A case the reviewer
// rejected does not count. A `skip` case counts: it is the written, reviewed
// decision not to test something (its automation_decision_reason says why),
// which is how a risk is accepted without a test. A risk only `skip` cases
// address is named, so the reviewer sees it was accepted, not tested.
//
// The check is mechanical; whether the cases are the RIGHT ones stays the
// reviewer's judgment. `config/gate-checks.json` decides what a gap does:
// `warn` (the default) names it in the brief, `block` keeps the gate closed
// until the scope covers the story.

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
 *   skipOnlyRisks: string[], acs: number, risks: number }} ScopeCoverage
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
  const uncoveredAcs = acs
    .map((_, i) =>
      cases.some((c) => (c.acceptance_criteria_refs ?? []).includes(i))
        ? 0
        : i + 1
    )
    .filter((n) => n > 0);
  /** @type {string[]} */
  const uncoveredRisks = [];
  /** @type {string[]} */
  const skipOnlyRisks = [];
  for (const r of risks) {
    const mine = cases.filter((c) => (c.risk_ids ?? []).includes(r.risk_id));
    if (!mine.length) uncoveredRisks.push(r.risk_id);
    else if (mine.every((c) => c.automation_decision === 'skip')) {
      skipOnlyRisks.push(r.risk_id);
    }
  }
  return {
    uncoveredAcs,
    uncoveredRisks,
    skipOnlyRisks,
    acs: acs.length,
    risks: risks.length,
  };
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
  const gaps = coverageGaps(cov);
  const skipped = cov.skipOnlyRisks.length
    ? `; ${cov.skipOnlyRisks.join(', ')} ${cov.skipOnlyRisks.length === 1 ? 'is' : 'are'} accepted without a test (only skip cases)`
    : '';
  return gaps
    ? `ATTENTION: ${gaps}${skipped}`
    : `every acceptance criterion (${cov.acs}) and risk (${cov.risks}) has at least one approved case${skipped}`;
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
