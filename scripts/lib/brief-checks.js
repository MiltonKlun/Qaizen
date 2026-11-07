// @ts-check
// The automatic checks a gate brief shows, one line each (scripts/run-pipeline.js
// prints them under "Auto-checks"; the gate record keeps them).
//
// They live in one function, outside the interactive prompt, so each gate's
// checks are tested: a check lost in a merge fails the suite instead of
// silently disappearing from the brief. They inform the reviewer and never
// decide a gate; blocking on scope coverage, when configured, is the gate's
// input check (config/gate-checks.json).
//
//   Gate 1   every acceptance criterion is the story's own text, not cut
//            short, out of scope or from a comment (criteria-check.js);
//            the track the run is held to and what it requires;
//            the story has no hidden text; every risk is scored
//            likelihood × impact
//   Gate 2   every criterion and risk has an approved case; the mix of test
//            design techniques behind the cases
//   lite     both (the consolidated gate reviews Gates 1 and 2 together)
//   Gate 4   the repeat check: how each test fared over N runs of the same
//            code (repeat-check.js)
//   every    how often this gate was rejected in this run; from the third
//            rejection on, an advice to revisit the story or the scope
//            instead of another round (advisory: it blocks nothing)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readValidatedJson } from './artifact-io.js';
import { gateDigest } from './approval-binding.js';
import { repeatBriefLine, repeatState } from './repeat-check.js';
import { compareCriteria, criteriaLines } from './criteria-check.js';
import { techniqueLine, techniqueSummary } from './case-decisions.js';
import { hiddenText, hiddenTextLine } from './hidden-text.js';
import { coverageLine, scopeCoverage } from './scope-coverage.js';
import { GATE_KEYS } from '../pipeline-state.js';
import { FULL_TRACK_REQUIREMENTS, effectiveTrack } from '../track-floor.js';

/** @typedef {import('./approval-binding.js').Context} Context */

/**
 * The brief line for the run's track.
 * @param {ReturnType<typeof effectiveTrack>} t
 * @returns {string}
 */
export function trackLine(t) {
  const raised =
    t.track !== t.declared ? `, raised from ${t.declared} by its floor` : '';
  const why = t.reasons.length ? ` (${t.reasons.join('; ')})` : '';
  const requires =
    t.track === 'full'
      ? `; full requires: ${FULL_TRACK_REQUIREMENTS.join('; ')}`
      : '';
  return `track: ${t.track}${raised}; floor ${t.minimum}${why}${requires}`;
}

/** Rejections of one gate in one run after which the brief advises a change of course. */
export const REJECTION_ADVICE_AT = 3;

/** Where repeated rejections of a gate usually point. */
const REVISIT = {
  requirements_reviewed:
    'the story itself: agree it with its owner (product owner or ticket author) before asking the Analyst again',
  qa_scope_approved:
    'the story itself: agree it with its owner before asking the Analyst and the Test Designer again',
  test_scope_reviewed:
    'the story or its interpretation: reopen Gate 1, or agree the scope with the story owner, before another Test Designer round',
  specs_reviewed:
    'the approved scope (Gate 2) or the story: when the spec keeps being rejected, the cases it plans from are usually what is wrong, or the app does not do what they describe (a defect to raise, not a spec to bend)',
  code_reviewed:
    'the spec (Gate 3), then the approved scope: when the code keeps being rejected, what it was generated from is usually what is wrong, or the app is (a defect to raise)',
  collection_reviewed:
    "the cases' expected results (Gate 2) or the API's documented contract: when the collection keeps being rejected, one of them is usually wrong",
  api_assertions_reviewed:
    "the cases' expected results (Gate 2) or the API's documented contract, or the API itself (a defect to raise)",
  external_plan_reviewed:
    'the approved scope (Gate 2): which cases are manual, component or skip, and why',
  external_evidence_reviewed:
    "the execution and the plan's evidence requirements (the external Gate 3): what was run, and what proof each case asks for",
};

/**
 * How many times a gate was rejected in this run, and since its last
 * approval.
 * @param {Context} context
 * @param {string} gateKey
 * @returns {{ total: number, sinceApproval: number }}
 */
export function rejectionCount(context, gateKey) {
  const own = (
    Array.isArray(context?.gate_decisions) ? context.gate_decisions : []
  ).filter((d) => d?.gate === gateKey);
  const lastApproval = own.map((d) => d?.decision).lastIndexOf('approved');
  const rejected = (/** @type {any[]} */ ds) =>
    ds.filter((d) => d?.decision === 'rejected').length;
  return {
    total: rejected(own),
    sinceApproval: rejected(own.slice(lastApproval + 1)),
  };
}

/**
 * The brief line for a gate's rejections in this run, or null when it has
 * none. Advisory: a loop that keeps rejecting is a sign the inputs upstream
 * are wrong, and the human decides what to do about it.
 * @param {Context} context
 * @param {string} gateKey
 * @returns {string | null}
 */
export function rejectionLine(context, gateKey) {
  const { total: n, sinceApproval } = rejectionCount(context, gateKey);
  if (!n) return null;
  const since =
    sinceApproval === n ? '' : ` (${sinceApproval} since its last approval)`;
  if (n < REJECTION_ADVICE_AT)
    return `this gate was rejected ${n} time${n === 1 ? '' : 's'} before in this run${since}`;
  const where =
    /** @type {Record<string, string>} */ (REVISIT)[gateKey] ??
    'what this gate reviews was made from: the step before it, or the story';
  return `ATTENTION: this gate has been rejected ${n} times in this run${since}. Another round is unlikely to converge; consider revisiting ${where}. (Advisory: nothing is blocked.)`;
}

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_CASES_SCHEMA = join(REPO_DIR, 'schemas', 'test-cases.schema.json');

/**
 * @param {string} step the gate step (`gate1`, `gate2`, `qa_scope`, ...)
 * @param {Context} context
 * @param {string} [root] the run's folder
 * @returns {string[]} one line per check; none for a gate without checks
 */
export function briefChecks(step, context, root = '.') {
  /** @type {string[]} */
  const checks = [];
  const requirements = step === 'gate1' || step === 'qa_scope';
  const scope = step === 'gate2' || step === 'qa_scope';

  if (requirements) {
    // The Analyst copies the acceptance criteria verbatim; name each one
    // that is not, and how it differs, so a changed rule stands out.
    const storyPath = context?.story?.path || 'story.md';
    if (existsSync(join(root, storyPath))) {
      const story = readFileSync(join(root, storyPath), 'utf8');
      checks.push(
        ...criteriaLines(
          compareCriteria(context.acceptance_criteria ?? [], story),
          storyPath
        )
      );
      // Text the rendered ticket hides, or that speaks to an AI: shown to
      // the reviewer, never removed (the story's digest is what Gate 1 binds).
      checks.push(hiddenTextLine(storyPath, hiddenText(story)));
      // The track the run is held to, from the story as well as the context,
      // so the reviewer sees what it requires before approving.
      checks.push(trackLine(effectiveTrack(context, story)));
    }
    // Every risk scored likelihood × impact (the schema already holds each
    // severity to its matrix cell).
    /** @type {{ risk_id: string, likelihood?: string }[]} */
    const risks = context?.risks ?? [];
    const unscored = risks.filter((r) => !r.likelihood).map((r) => r.risk_id);
    if (risks.length) {
      checks.push(
        unscored.length
          ? `ATTENTION: ${unscored.join(', ')} ${unscored.length === 1 ? 'has' : 'have'} no likelihood × impact score (agents/analyst.md, the risk matrix)`
          : `every risk (${risks.length}) is scored likelihood × impact, with its severity on the matrix`
      );
    }
  }

  if (scope) {
    // Does the scope cover every criterion and risk?
    const casesPath = context?.artifact_paths?.test_cases;
    if (casesPath) {
      const read = readValidatedJson(join(root, casesPath), TEST_CASES_SCHEMA);
      if (read.ok) {
        checks.push(coverageLine(scopeCoverage(context, read.data)));
        // Which test design techniques produced the cases?
        checks.push(techniqueLine(techniqueSummary(read.data)));
      }
    }
  }
  if (step === 'gate4') {
    checks.push(
      repeatBriefLine(
        repeatState(context, gateDigest('code_reviewed', context, root))
      )
    );
  }
  const gateKey = /** @type {Record<string, string>} */ (GATE_KEYS)[step];
  const rejections = gateKey ? rejectionLine(context, gateKey) : null;
  if (rejections) checks.push(rejections);
  return checks;
}
