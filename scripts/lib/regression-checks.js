// @ts-check
// The checks a regression case can name, one per expected behavior.
//
// Each check reads one trial's output (the file the agent wrote for that
// trial) and the case's input, and says whether the expected behavior held.
// They reuse the checks the pipeline already runs on a real story: the Gate 1
// criteria comparison, the track floor, the test-case links and the Healer
// guardrails. A check never reads prose for meaning; what it cannot decide
// mechanically is not a check here.
//
// Pure: the caller loads the files.

import { checkCandidate } from '../healer-guardrails.js';
import { minimumTrack, trackRank, TRACK_ORDER } from '../track-floor.js';
import { compareCriteria } from './criteria-check.js';
import { ts } from './test-source.js';

/**
 * What one case gives its checks.
 * @typedef {{
 *   story: string | null,
 *   context: any,
 *   original: string | null,
 * }} CaseInput
 * @typedef {{ text: string, json: any }} TrialOutput
 *   `json` is the parsed file, or undefined when it is not JSON.
 * @typedef {{ pass: boolean, detail: string }} CheckResult
 * @typedef {(value: any, schema: string) => { ok: boolean, detail: string }} Validate
 * @typedef {{
 *   agents: string[],
 *   needs: (keyof CaseInput)[],
 *   keys?: string[],
 *   params?: (p: any, input: CaseInput) => string | null,
 *   run: (p: any, out: TrialOutput, input: CaseInput, validate: Validate)
 *     => CheckResult,
 * }} CheckDef
 */

/**
 * The file each agent's trial leaves. The Healer's is the test as the Healer
 * left it, unchanged when it declined.
 */
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

const ACCEPTANCE_HEADING =
  /^#{1,6}\s*(?:acceptance criteria|criterios de aceptaci[oó]n)\b/i;

/**
 * The list items under the story's acceptance-criteria heading.
 * @param {string} story
 * @returns {string[]}
 */
export function storyCriteria(story) {
  const lines = story.split('\n');
  const start = lines.findIndex((l) => ACCEPTANCE_HEADING.test(l.trim()));
  if (start === -1) return [];
  /** @type {string[]} */
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (item) items.push(item[1].trim());
    else if (line.trim() && !line.trim().startsWith('<!--') && items.length)
      items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/**
 * The code tokens of a test file: comments, whitespace and line breaks left
 * out, so a reformatted or commented file is the same code.
 * @param {string} text
 * @returns {string[]}
 */
export function codeTokens(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text
  );
  /** @type {string[]} */
  const tokens = [];
  for (
    let t = scanner.scan();
    t !== ts.SyntaxKind.EndOfFileToken;
    t = scanner.scan()
  )
    tokens.push(scanner.getTokenText());
  return tokens;
}

const sameCode = (/** @type {string} */ a, /** @type {string} */ b) =>
  codeTokens(a).join('\u0000') === codeTokens(b).join('\u0000');

/** The criteria of the input context whose text contains `text`. */
const matchingCriteria = (
  /** @type {string} */ text,
  /** @type {any} */ context
) =>
  /** @type {string[]} */ (context?.acceptance_criteria ?? []).flatMap(
    (ac, i) => (ac.toLowerCase().includes(text.toLowerCase()) ? [i] : [])
  );

const texts = (/** @type {any} */ p) =>
  Array.isArray(p.texts) &&
  p.texts.length &&
  p.texts.every((/** @type {unknown} */ t) => typeof t === 'string' && t)
    ? null
    : 'texts must be a non-empty list of strings';

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
  // The story's criteria, each once, word for word, and nothing else.
  criteria_verbatim: {
    agents: ['analyst'],
    needs: ['story'],
    params: (_p, input) =>
      storyCriteria(/** @type {string} */ (input.story)).length
        ? null
        : 'the story has no acceptance-criteria list to compare with',
    run: (_p, out, input) => {
      const acs = out.json?.acceptance_criteria;
      if (!Array.isArray(acs) || !acs.every((a) => typeof a === 'string'))
        return no('no acceptance_criteria list');
      const story = /** @type {string} */ (input.story);
      const issues = compareCriteria(acs, story)
        .filter((r) => r.status === 'issue')
        .map((r) => `AC ${r.n} ${r.issues.join('; ')}`);
      if (issues.length) return no(issues.join(' | '));
      const items = storyCriteria(story);
      /** @type {number[]} */
      const used = [];
      for (const [n, ac] of acs.entries()) {
        const i = items.findIndex(
          (item, j) =>
            !used.includes(j) &&
            compareCriteria([ac], item)[0].status !== 'issue'
        );
        if (i === -1)
          return no(
            `AC ${n + 1} is not one of the story's criteria, or repeats one`
          );
        used.push(i);
      }
      const missing = items.flatMap((_, j) =>
        used.includes(j) ? [] : [j + 1]
      );
      return missing.length
        ? no(`the story's criterion ${missing.join(', ')} is missing`)
        : ok();
    },
  },
  // What the Analyst wrote carries the story's Red domain, so the runner
  // holds it to `floor`; a track it proposes is never below its own floor
  // (agents/analyst.md: standard for a Red-domain story, which the runner
  // raises). Proposing no track is allowed.
  track_floor: {
    agents: ['analyst'],
    needs: ['story'],
    keys: ['floor'],
    params: (p) =>
      TRACK_ORDER.includes(p.floor)
        ? null
        : `floor must be one of ${TRACK_ORDER.join(', ')}`,
    run: (p, out, input) => {
      const ctx = out.json;
      if (ctx === undefined) return no('context.json is not JSON');
      const fromContext = minimumTrack(ctx, null).minimum;
      if (trackRank(fromContext) < trackRank(p.floor))
        return no(
          `the floor from what the Analyst wrote is ${fromContext}, the story's is ${p.floor}`
        );
      if (ctx.track === undefined) return ok('no track proposed');
      if (!TRACK_ORDER.includes(ctx.track))
        return no(`proposed an unknown track "${ctx.track}"`);
      const own = minimumTrack(ctx, input.story).minimum;
      const lowest = own === 'full' ? 'standard' : own;
      return trackRank(ctx.track) >= trackRank(lowest)
        ? ok(ctx.track)
        : no(`proposed ${ctx.track}, below its floor ${lowest}`);
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
  // `text` names exactly one criterion of the input context (a literal,
  // case-insensitive), and an automated case must reference it.
  automated_case_for_criterion: {
    agents: ['test-designer'],
    needs: ['context'],
    keys: ['text'],
    params: (p, input) => {
      if (typeof p.text !== 'string' || !p.text) return 'text must be a string';
      const n = matchingCriteria(p.text, input.context).length;
      return n === 1
        ? null
        : `"${p.text}" names ${n} criteria of the input context; it must name one`;
    },
    run: (p, out, input) => {
      const [wanted] = matchingCriteria(p.text, input.context);
      const covering = (out.json?.test_cases ?? []).filter(
        (/** @type {any} */ tc) =>
          AUTOMATED.has(tc.automation_decision) &&
          (tc.acceptance_criteria_refs ?? []).includes(wanted)
      );
      return covering.length
        ? ok(
            covering.map((/** @type {any} */ tc) => tc.test_case_id).join(', ')
          )
        : no(`no automated case covers criterion ${wanted + 1}`);
    },
  },

  // -------------------------------------------------------------- Healer --
  // The test's code is unchanged (comments and formatting aside). A
  // test.fixme or a skip is a change, and fails.
  declines: {
    agents: ['healer'],
    needs: ['original'],
    run: (_p, out, input) =>
      sameCode(out.text, /** @type {string} */ (input.original))
        ? ok()
        : no('changed the test where the expected behavior is to decline'),
  },
  candidate_eligible: {
    agents: ['healer'],
    needs: ['original'],
    run: (_p, out, input) => {
      const original = /** @type {string} */ (input.original);
      if (sameCode(out.text, original))
        return no('declined, a repair was expected');
      const c = checkCandidate(original, out.text, {
        fileName: 'candidate.spec.ts',
      });
      return c.eligible
        ? ok()
        : no(`the guardrails refuse it: ${c.violations.join('; ')}`);
    },
  },
  // Each text appears in the code (a string literal counts; a comment does
  // not).
  candidate_contains: {
    agents: ['healer'],
    needs: ['original'],
    keys: ['texts'],
    params: texts,
    run: (p, out) => {
      const code = codeTokens(out.text);
      const absent = p.texts.filter(
        (/** @type {string} */ t) => !code.some((tok) => tok.includes(t))
      );
      return absent.length
        ? no(`its code does not contain ${absent.join(', ')}`)
        : ok();
    },
  },
  // No text appears in the code any more.
  candidate_omits: {
    agents: ['healer'],
    needs: ['original'],
    keys: ['texts'],
    params: texts,
    run: (p, out) => {
      const code = codeTokens(out.text);
      const present = p.texts.filter((/** @type {string} */ t) =>
        code.some((tok) => tok.includes(t))
      );
      return present.length
        ? no(`its code still contains ${present.join(', ')}`)
        : ok();
    },
  },
};
