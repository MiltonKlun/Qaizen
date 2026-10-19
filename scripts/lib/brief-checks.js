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
//   Gate 1   every acceptance criterion appears word for word in the story;
//            the story has no hidden text; every risk is scored
//            likelihood × impact
//   Gate 2   every criterion and risk has an approved case; the mix of test
//            design techniques behind the cases
//   lite     both (the consolidated gate reviews Gates 1 and 2 together)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { criteriaNotInStory } from '../gate-briefs.js';
import { readValidatedJson } from './artifact-io.js';
import { techniqueLine, techniqueSummary } from './case-decisions.js';
import { hiddenText, hiddenTextLine } from './hidden-text.js';
import { coverageLine, scopeCoverage } from './scope-coverage.js';

/** @typedef {import('./approval-binding.js').Context} Context */

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
    // The Analyst copies the acceptance criteria verbatim; say whether each
    // one is in the story, so a reworded or invented one stands out.
    const storyPath = context?.story?.path || 'story.md';
    if (existsSync(join(root, storyPath))) {
      const story = readFileSync(join(root, storyPath), 'utf8');
      const missing = criteriaNotInStory(
        context.acceptance_criteria ?? [],
        story
      );
      checks.push(
        missing.length
          ? `ATTENTION: ${missing.map((n) => `AC ${n}`).join(', ')} not found word for word in ${storyPath}; check ${missing.length === 1 ? 'it is' : 'they are'} not reworded or invented`
          : `every acceptance criterion appears word for word in ${storyPath}`
      );
      // Text the rendered ticket hides, or that speaks to an AI: shown to
      // the reviewer, never removed (the story's digest is what Gate 1 binds).
      checks.push(hiddenTextLine(storyPath, hiddenText(story)));
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
  return checks;
}
