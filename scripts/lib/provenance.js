// @ts-check
// What produced each artifact.
//
// A self-declared prompt version says what an agent claims to be; the file's
// digest says what it was. For each agent step the runner records the SHA-256
// of every prompt file the step uses (its agent prompt and skills, and for the
// Playwright Planner and Generator the generated .claude/agents/ definitions,
// untracked as they are), the model id and harness version the operator
// declared for the session, the step's output and the date. It records them
// the first time it sees the step's output, and again when the output changes.
//
// The model id comes from QAIZEN_MODEL and the harness version from
// QAIZEN_HARNESS, declared once per session like the reviewer name; the runner
// cannot see which model ran an agent, so an undeclared one is "unknown".
// Older runs have no provenance and are shown as unknown (nothing is
// backfilled).
//
// Pure apart from reading the prompt files.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The prompt files each agent step uses. */
export const STEP_PROMPTS = Object.freeze({
  analyst: ['agents/analyst.md', 'skills/receiving-tickets/SKILL.md'],
  'test-designer': [
    'agents/test-designer.md',
    'skills/designing-cases/SKILL.md',
    'skills/planning-tests/SKILL.md',
  ],
  planner: ['.claude/agents/playwright-test-planner.md'],
  generator: ['.claude/agents/playwright-test-generator.md'],
  api: ['agents/api-agent.md'],
  'external-plan': [
    'agents/test-designer.md',
    'skills/designing-cases/SKILL.md',
  ],
  finalize: ['agents/failure-classifier.md', 'skills/analyzing-logs/SKILL.md'],
  report: ['agents/reporter.md'],
});

/** The prompt files Gate 3 binds: the Planner's and the Generator's. */
export const GATE3_PROMPTS = [
  ...STEP_PROMPTS.planner,
  ...STEP_PROMPTS.generator,
];

/** What a model or harness is when nobody declared it. */
export const UNKNOWN = 'unknown';

/**
 * @typedef {{ path: string, sha256: string | null }} PromptDigest
 * @typedef {{ prompts: PromptDigest[], model: string, harness: string,
 *   output: { path: string, sha256: string }, recorded_at: string }} StepProvenance
 */

/** @param {Buffer | string} b */
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The digest of each prompt file, null for one that does not exist (the
 * generated agent definitions on a machine that never ran init-agents).
 * Line endings are normalized, so a checkout's autocrlf changes nothing.
 * @param {string[]} paths repository-relative
 * @param {string} root the repository
 * @returns {PromptDigest[]}
 */
export function promptDigests(paths, root) {
  return paths.map((path) => {
    const abs = join(root, path);
    return {
      path,
      sha256: existsSync(abs)
        ? sha256(readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'))
        : null,
    };
  });
}

/**
 * The provenance of one step, now.
 * @param {string} step
 * @param {{ root: string, output: { path: string, sha256: string },
 *   env?: Record<string, string | undefined>, now?: string }} args
 * @returns {StepProvenance}
 */
export function stepProvenance(step, { root, output, env = {}, now }) {
  const paths = /** @type {Record<string, string[]>} */ (STEP_PROMPTS)[step];
  if (!paths) throw new Error(`no prompt files are mapped for step "${step}"`);
  return {
    prompts: promptDigests(paths, root),
    model: (env.QAIZEN_MODEL || '').trim() || UNKNOWN,
    harness: (env.QAIZEN_HARNESS || '').trim() || UNKNOWN,
    output,
    recorded_at: now ?? new Date().toISOString(),
  };
}

/**
 * Whether a step's recorded provenance is missing or names another output,
 * so it should be recorded now.
 * @param {any} context
 * @param {string} step
 * @param {string} outputDigest the step's output digest now
 */
export function needsProvenance(context, step, outputDigest) {
  return context?.provenance?.[step]?.output?.sha256 !== outputDigest;
}

/**
 * The --status lines for the run's provenance.
 * @param {any} context
 * @param {string[]} steps the agent steps this run has reached, in order
 * @returns {string[]}
 */
export function provenanceLines(context, steps) {
  const recorded = context?.provenance ?? {};
  if (!steps.length) return [];
  return [
    'Provenance:',
    ...steps.map((step) => {
      const p = recorded[step];
      if (!p) return `  ${step}: unknown (not recorded)`;
      const files = p.prompts
        .map(
          (/** @type {PromptDigest} */ f) =>
            `${f.path} ${f.sha256 ? f.sha256.slice(0, 12) : '(missing)'}`
        )
        .join(', ');
      return `  ${step}: ${files}; model ${p.model}, harness ${p.harness}, ${p.recorded_at}`;
    }),
  ];
}

/**
 * Each agent step's output in this run, as a path and a digest, or null when
 * the step has not produced it yet. A runner-written field never counts as
 * output: the Analyst's is the interpretation it wrote (criteria, risks,
 * ambiguities, track), and the Test Designer's leaves out the per-case
 * decisions the reviewer records before Gate 2.
 * @param {any} context
 * @param {string} root the run's folder
 * @param {{ api?: string | null, externalPlan?: string | null }} [paths]
 *   the API collection and external plan paths, when the run has them
 * @returns {Record<string, { path: string, sha256: string } | null>}
 */
export function stepOutputs(context, root, paths = {}) {
  const ap = context?.artifact_paths ?? {};
  /** @type {(rel: string | null | undefined, transform?: (s: string) => string) => { path: string, sha256: string } | null} */
  const file = (rel, transform = (s) => s) => {
    if (!rel || !existsSync(join(root, rel))) return null;
    const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    return { path: rel, sha256: sha256(transform(text)) };
  };
  const json =
    (/** @type {(v: any) => any} */ f) => (/** @type {string} */ s) => {
      try {
        return JSON.stringify(f(JSON.parse(s)));
      } catch {
        return s;
      }
    };
  const finalized = (() => {
    try {
      const fa = ap.failure_analysis
        ? JSON.parse(readFileSync(join(root, ap.failure_analysis), 'utf8'))
        : null;
      return fa?.status === 'finalized';
    } catch {
      return false;
    }
  })();
  return {
    analyst: context
      ? {
          path: 'context.json',
          sha256: sha256(
            JSON.stringify({
              acceptance_criteria: context.acceptance_criteria ?? [],
              risks: context.risks ?? [],
              ambiguities: context.ambiguities ?? [],
              track: context.track ?? null,
            })
          ),
        }
      : null,
    'test-designer': file(
      ap.test_cases,
      json((doc) => ({
        ...doc,
        test_cases: (doc?.test_cases ?? []).map((/** @type {any} */ c) =>
          Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'status'))
        ),
      }))
    ),
    planner: file(ap.playwright_spec),
    generator: file(ap.generated_test),
    api: file(paths.api),
    'external-plan': file(paths.externalPlan),
    finalize: finalized ? file(ap.failure_analysis) : null,
    report: file(ap.release_report_json),
  };
}
