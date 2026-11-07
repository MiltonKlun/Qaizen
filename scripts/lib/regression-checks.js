// @ts-check
// The checks a regression case can name, one per expected behavior.
//
// Each check reads one trial's output (the file the agent wrote for that
// trial) and the case's input, and says whether the expected behavior held.
// They reuse the checks the pipeline already runs on a real story: the Gate 1
// criteria comparison, the track order, the test-case links and the Healer
// guardrails. A check never reads prose for meaning; what it cannot decide
// mechanically is not a check here.
//
// Pure: the caller loads the files.

import { checkCandidate } from '../healer-guardrails.js';
import { trackRank, TRACK_ORDER } from '../track-floor.js';
import { compareCriteria } from './criteria-check.js';

/**
 * What one case gives its checks.
 * @typedef {{
 *   story: string | null,
 *   context: any,
 *   original: string | null,
 * }} CaseInput
 * @typedef {{ text: string | null, json: any }} TrialOutput
 *   `text` is null when the trial wrote no output file (a Healer that
 *   declined); `json` is the parsed file, or undefined when it is not JSON.
 * @typedef {{ pass: boolean, detail: string }} CheckResult
 * @typedef {{
 *   agents: string[],
 *   needs: (keyof CaseInput)[],
 *   params?: (p: any, input: CaseInput) => string | null,
 *   run: (p: any, out: TrialOutput, input: CaseInput,
 *     validate: (value: any, schema: string) => { ok: boolean, detail: string })
 *     => CheckResult,
 * }} CheckDef
 */

/** The file each agent writes for one trial. */
export const TRIAL_OUTPUT = Object.freeze({
  analyst: 'context.json',
  'test-designer': 'test-cases.json',
  healer: 'candidate.spec.ts',
});

/** An automated decision, as the Automation Decision Model names it. */
const AUTOMATED = new Set([
  'automate_e2e',
  'automate_api',
  'automate_component',
]);

const ok = (detail = '') => ({ pass: true, detail });
const no = (/** @type {string} */ detail) => ({ pass: false, detail });

/**
 * The criteria of the input context whose text matches the case's pattern.
 * @param {string} pattern
 * @param {any} context
 * @returns {number[]} their indices
 */
function matchingCriteria(pattern, context) {
  const re = new RegExp(pattern, 'i');
  return (context?.acceptance_criteria ?? [])
    .map((/** @type {string} */ ac, /** @type {number} */ i) => ({ ac, i }))
    .filter((/** @type {{ ac: string }} */ x) => re.test(x.ac))
    .map((/** @type {{ i: number }} */ x) => x.i);
}

/** @type {Record<string, CheckDef>} */
export const CHECKS = {
  // ------------------------------------------------------------ Analyst --
  context_valid: {
    agents: ['analyst'],
    needs: [],
    run: (_p, out, _input, validate) => {
      if (out.json === undefined) return no('context.json is not JSON');
      const v = validate(out.json, 'context.schema.json');
      return v.ok ? ok() : no(`does not validate: ${v.detail}`);
    },
  },
  criteria_verbatim: {
    agents: ['analyst'],
    needs: ['story'],
    params: (p) =>
      p.count === undefined || (Number.isInteger(p.count) && p.count > 0)
        ? null
        : 'count must be a positive integer',
    run: (p, out, input) => {
      const acs = out.json?.acceptance_criteria;
      if (!Array.isArray(acs)) return no('no acceptance_criteria array');
      if (p.count !== undefined && acs.length !== p.count)
        return no(`${acs.length} criteria, the story has ${p.count}`);
      const issues = compareCriteria(acs, /** @type {string} */ (input.story))
        .filter((r) => r.status === 'issue')
        .map((r) => `AC ${r.n} ${r.issues.join('; ')}`);
      return issues.length ? no(issues.join(' | ')) : ok();
    },
  },
  track_at_least: {
    agents: ['analyst'],
    needs: [],
    params: (p) =>
      TRACK_ORDER.includes(p.track)
        ? null
        : `track must be one of ${TRACK_ORDER.join(', ')}`,
    run: (p, out) => {
      const t = out.json?.track;
      if (!TRACK_ORDER.includes(t)) return no('no track declared');
      return trackRank(t) >= trackRank(p.track)
        ? ok(t)
        : no(`declared ${t}, expected at least ${p.track}`);
    },
  },

  // ------------------------------------------------------- Test Designer --
  test_cases_valid: {
    agents: ['test-designer'],
    needs: ['context'],
    run: (_p, out, input, validate) => {
      const doc = out.json;
      if (doc === undefined) return no('test-cases.json is not JSON');
      const v = validate(doc, 'test-cases.schema.json');
      if (!v.ok) return no(`does not validate: ${v.detail}`);
      const ctx = input.context;
      if (doc.story_id !== ctx?.story?.id)
        return no(`story_id ${doc.story_id}, the context is ${ctx?.story?.id}`);
      const risks = new Set(
        (ctx.risks ?? []).map((/** @type {any} */ r) => r.risk_id)
      );
      const acs = (ctx.acceptance_criteria ?? []).length;
      for (const tc of doc.test_cases ?? []) {
        const unknown = (tc.risk_ids ?? []).find(
          (/** @type {string} */ r) => !risks.has(r)
        );
        if (unknown)
          return no(`${tc.test_case_id} references unknown ${unknown}`);
        const bad = (tc.acceptance_criteria_refs ?? []).find(
          (/** @type {number} */ i) => !Number.isInteger(i) || i < 0 || i >= acs
        );
        if (bad !== undefined)
          return no(`${tc.test_case_id} references criterion ${bad}`);
      }
      return ok();
    },
  },
  automated_case_for_criterion: {
    agents: ['test-designer'],
    needs: ['context'],
    params: (p, input) => {
      if (typeof p.pattern !== 'string' || !p.pattern)
        return 'pattern must be a non-empty regular expression';
      try {
        return matchingCriteria(p.pattern, input.context).length
          ? null
          : `pattern /${p.pattern}/i matches no criterion of the input context`;
      } catch (e) {
        return `pattern is not a regular expression: ${/** @type {Error} */ (e).message}`;
      }
    },
    run: (p, out, input) => {
      const wanted = matchingCriteria(p.pattern, input.context);
      const covering = (out.json?.test_cases ?? []).filter(
        (/** @type {any} */ tc) =>
          AUTOMATED.has(tc.automation_decision) &&
          (tc.acceptance_criteria_refs ?? []).some((/** @type {number} */ i) =>
            wanted.includes(i)
          )
      );
      return covering.length
        ? ok(
            covering.map((/** @type {any} */ tc) => tc.test_case_id).join(', ')
          )
        : no(
            `no automated case covers criterion ${wanted.map((i) => i + 1).join(' or ')}`
          );
    },
  },

  // -------------------------------------------------------------- Healer --
  declines: {
    agents: ['healer'],
    needs: ['original'],
    run: (_p, out, input) =>
      out.text === null || out.text === input.original
        ? ok()
        : no('proposed a change where the expected behavior is to decline'),
  },
  candidate_eligible: {
    agents: ['healer'],
    needs: ['original'],
    run: (_p, out, input) => {
      if (out.text === null) return no('declined, a repair was expected');
      if (out.text === input.original) return no('the candidate is unchanged');
      const c = checkCandidate(
        /** @type {string} */ (input.original),
        out.text,
        { fileName: 'candidate.spec.ts' }
      );
      return c.eligible
        ? ok()
        : no(`the guardrails refuse it: ${c.violations.join('; ')}`);
    },
  },
  candidate_contains: {
    agents: ['healer'],
    needs: ['original'],
    params: (p) =>
      Array.isArray(p.texts) &&
      p.texts.length &&
      p.texts.every((/** @type {unknown} */ t) => typeof t === 'string' && t)
        ? null
        : 'texts must be a non-empty list of strings',
    run: (p, out) => {
      if (out.text === null) return no('declined, a repair was expected');
      const absent = p.texts.filter(
        (/** @type {string} */ t) => !out.text?.includes(t)
      );
      return absent.length ? no(`does not contain ${absent.join(', ')}`) : ok();
    },
  },
};
