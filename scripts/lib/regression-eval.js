// @ts-check
// The regression set: what the agents must keep doing, scored over k trials.
//
// examples/evaluation/regressions/manifest.json lists the cases (each an
// input, the agent it is for, the behavior expected of it, the checks that
// decide it and where it came from), the number of trials k and the decision
// rule. The evaluator never runs an agent: the person evaluating a prompt or
// model change runs the agent k times on each case's input and puts each
// output in <trials-dir>/<case-id>/trial-<n>/. This scores every trial, and
// reports per case how many of the k trials passed, pass^k (every trial
// passed) and a Wilson 95% interval on its pass rate; then the share of cases
// that passed every trial, with its interval, and the decision the rule gives.
//
// The rule is written before the run: the evaluator refuses a set with
// uncommitted changes and records the set's git tree, so the rule and the
// cases that judged a change are in history before the results. The results
// go to evidence/regressions/<agent|all>.json and are rewritten only when what
// they measured changes. "Previous" in the rule is the committed version of
// that file, never the working copy, so re-running a blocked change does not
// make it its own baseline.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatErrors, validateValue } from './artifact-io.js';
import { promptDigests, STEP_PROMPTS, UNKNOWN } from './provenance.js';
import { CHECKS, TRIAL_OUTPUT } from './regression-checks.js';
import { writeResultsIfChanged } from './results-file.js';

export const SET_DIR = 'examples/evaluation/regressions';
export const MANIFEST = `${SET_DIR}/manifest.json`;
export const RESULTS_DIR = 'evidence/regressions';

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas'
);
const schemaFile = (/** @type {string} */ name) => join(SCHEMA_DIR, name);

/** z for a two-sided 95% interval. */
const Z_95 = 1.959964;

/** The prompt files behind each agent a case can be for. */
export const AGENT_PROMPTS = Object.freeze({
  analyst: STEP_PROMPTS.analyst,
  'test-designer': STEP_PROMPTS['test-designer'],
  healer: ['.claude/agents/playwright-test-healer.md'],
});

/**
 * @typedef {{ check: string, [param: string]: unknown }} CheckRef
 * @typedef {{ id: string, agent: keyof typeof TRIAL_OUTPUT,
 *   source: { kind: string, description: string }, input: string,
 *   expected: string, checks: CheckRef[] }} RegressionCase
 * @typedef {{ statement: string, block_when_a_case_fails_every_trial: boolean,
 *   block_below_previous_lower_bound: boolean }} DecisionRule
 * @typedef {{ value: number | null, wilson_95: [number, number] | null }} Rate
 * @typedef {import('./regression-checks.js').CaseInput} CaseInput
 * @typedef {import('./regression-checks.js').Validate} Validate
 * @typedef {{ source: string, pass_k: Rate | null, cases_added: string[],
 *   cases_removed: string[], set_changed: boolean, compared: boolean }} Previous
 */

const round4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const sha256 = (/** @type {string} */ s) =>
  createHash('sha256').update(s).digest('hex');
/** Line endings and a byte-order mark are not content. */
export const normalize = (/** @type {string} */ s) =>
  s.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * The Wilson score interval for `successes` out of `n`, at 95%.
 * @param {number} successes
 * @param {number} n
 * @returns {[number, number] | null} null when nothing was tried
 */
export function wilson(successes, n) {
  if (!n) return null;
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [
    round4(Math.max(0, centre - half)),
    round4(Math.min(1, centre + half)),
  ];
}

/**
 * @param {number} successes
 * @param {number} n
 * @returns {Rate}
 */
const rate = (successes, n) => ({
  value: n ? round4(successes / n) : null,
  wilson_95: wilson(successes, n),
});

/**
 * A case's input files, read from its folder.
 * @param {string} root
 * @param {RegressionCase} c
 * @returns {CaseInput}
 */
export function loadInput(root, c) {
  const dir = join(root, SET_DIR, c.input);
  const text = (/** @type {string} */ name) =>
    existsSync(join(dir, name))
      ? normalize(readFileSync(join(dir, name), 'utf8'))
      : null;
  const ctx = text('context.json');
  return {
    story: text('story.md'),
    context: ctx === null ? null : JSON.parse(ctx),
    original: text('original.spec.ts'),
  };
}

/**
 * What is wrong with a case's definition, before any trial is read.
 * @param {RegressionCase} c
 * @param {CaseInput} input
 * @returns {string[]}
 */
export function caseErrors(c, input) {
  /** @type {string[]} */
  const errors = [];
  for (const ref of c.checks) {
    const def = CHECKS[ref.check];
    if (!def) {
      errors.push(`${c.id}: unknown check "${ref.check}"`);
      continue;
    }
    if (!def.agents.includes(c.agent))
      errors.push(`${c.id}: check "${ref.check}" is not for the ${c.agent}`);
    const extra = Object.keys(ref).filter(
      (k) => k !== 'check' && !(def.keys ?? []).includes(k)
    );
    if (extra.length)
      errors.push(`${c.id}: check "${ref.check}" takes no ${extra.join(', ')}`);
    const missing = def.needs.filter((k) => input[k] === null);
    if (missing.length) {
      errors.push(
        `${c.id}: check "${ref.check}" needs ${missing.join(', ')} in ${SET_DIR}/${c.input}`
      );
      continue;
    }
    const bad = def.params?.(ref, input);
    if (bad) errors.push(`${c.id}: check "${ref.check}": ${bad}`);
  }
  return errors;
}

/**
 * Score one trial's output against every check of its case.
 * @param {RegressionCase} c
 * @param {CaseInput} input
 * @param {string} text the output file's text, normalized
 * @param {Validate} validate
 */
export function scoreTrial(c, input, text, validate) {
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const failed = c.checks
    .map((ref) => ({
      check: ref.check,
      ...CHECKS[ref.check].run(ref, { text, json }, input, validate),
    }))
    .filter((r) => !r.pass)
    .map(({ check, detail }) => ({ check, detail }));
  return { pass: failed.length === 0, failed };
}

/**
 * One case's result over its trials.
 * @param {RegressionCase} c
 * @param {{ output_sha256: string, pass: boolean,
 *   failed: { check: string, detail: string }[] }[]} trials
 */
export function caseResult(c, trials) {
  const passed = trials.filter((t) => t.pass).length;
  return {
    id: c.id,
    agent: c.agent,
    source: c.source.kind,
    expected: c.expected,
    trials: trials.length,
    passed,
    pass_k: passed === trials.length,
    pass_rate: rate(passed, trials.length),
    trial_results: trials.map((t, i) => ({ trial: i + 1, ...t })),
  };
}

/**
 * The share of cases that passed every trial, and of trials that passed.
 * @param {ReturnType<typeof caseResult>[]} cases
 */
export function aggregate(cases) {
  const all = cases.filter((c) => c.pass_k).length;
  const trials = cases.reduce((a, c) => a + c.trials, 0);
  const passed = cases.reduce((a, c) => a + c.passed, 0);
  return {
    pass_k: { cases: cases.length, passed: all, ...rate(all, cases.length) },
    per_trial: { trials, passed, ...rate(passed, trials) },
  };
}

/**
 * The decision the rule gives. The lower bound is compared only with
 * previous results of the same set: other cases, or the same cases with other
 * inputs, measure something else.
 * @param {DecisionRule} rule
 * @param {number} k
 * @param {ReturnType<typeof caseResult>[]} cases
 * @param {ReturnType<typeof aggregate>} agg
 * @param {Previous | null} previous
 * @returns {{ verdict: 'pass' | 'block', reasons: string[] }}
 */
export function decide(rule, k, cases, agg, previous) {
  /** @type {string[]} */
  const reasons = [];
  if (rule.block_when_a_case_fails_every_trial)
    for (const c of cases)
      if (c.passed === 0) reasons.push(`${c.id} failed all ${k} trials`);
  const bound = previous?.compared ? previous.pass_k?.wilson_95?.[0] : null;
  if (
    rule.block_below_previous_lower_bound &&
    typeof bound === 'number' &&
    agg.pass_k.value !== null &&
    agg.pass_k.value < bound
  )
    reasons.push(
      `pass^${k} is ${agg.pass_k.value}, below the previous lower bound ${bound}`
    );
  return { verdict: reasons.length ? 'block' : 'pass', reasons };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/**
 * Whether the set (rule, cases, inputs) is committed as it is on disk, and
 * the git tree it is committed as.
 * @param {string} root
 * @returns {{ ok: true, tree: string } | { ok: false, reason: string }}
 */
export function setCommitted(root) {
  const status = git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    SET_DIR,
  ]);
  if (status.error || status.status !== 0)
    return {
      ok: false,
      reason:
        'cannot ask git whether the regression set is committed (not a git work tree?)',
    };
  if (status.stdout.trim())
    return {
      ok: false,
      reason: `${SET_DIR} has uncommitted changes:\n${status.stdout.trimEnd()}\nCommit the decision rule and the cases before the run, so they are in history before the results they judge.`,
    };
  const tree = git(root, ['rev-parse', `HEAD:${SET_DIR}`]);
  if (tree.status !== 0)
    return { ok: false, reason: `${SET_DIR} is not committed.` };
  return { ok: true, tree: tree.stdout.trim() };
}

/**
 * The committed version of the results file at `outPath`, or null when it is
 * outside the repository or has never been committed.
 * @param {string} root
 * @param {string} outPath absolute
 * @returns {{ ok: true, source: string, doc: any } | { ok: true, source: null }
 *   | { ok: false, reason: string }}
 */
export function committedResults(root, outPath) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { ok: true, source: null };
  const rel = relative(resolve(top.stdout.trim()), outPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    return { ok: true, source: null };
  const path = rel.split(sep).join('/');
  const shown = git(root, ['show', `HEAD:${path}`]);
  if (shown.status !== 0) return { ok: true, source: null };
  const source = `HEAD:${path}`;
  let doc;
  try {
    doc = JSON.parse(normalize(shown.stdout));
  } catch {
    return { ok: false, reason: `${source} is not JSON.` };
  }
  const v = validateValue(doc, schemaFile('regression-results.schema.json'));
  if (!v.ok)
    return {
      ok: false,
      reason: `${source} does not validate against schemas/regression-results.schema.json:\n${formatErrors(v.errors).join('\n')}`,
    };
  return { ok: true, source, doc };
}

/**
 * Score a set of trials.
 * @param {{
 *   root: string,
 *   manifest: { trials: number, decision_rule: DecisionRule,
 *     cases: RegressionCase[] },
 *   manifestText: string,
 *   setTree: string,
 *   trialsDir: string,
 *   agent: string | null,
 *   previous: { source: string, doc: any } | null,
 *   model: string,
 *   harness: string,
 *   now: string,
 *   validate: Validate,
 * }} args
 * @returns {{ ok: false, errors: string[] } | { ok: true, doc: any }}
 */
export function evaluateSet({
  root,
  manifest,
  manifestText,
  setTree,
  trialsDir,
  agent,
  previous,
  model,
  harness,
  now,
  validate,
}) {
  const k = manifest.trials;
  /** @type {string[]} */
  const errors = [];
  const ids = manifest.cases.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`${MANIFEST} lists ${dup} more than once`);
  const cases = manifest.cases.filter((c) => !agent || c.agent === agent);
  if (!cases.length) errors.push(`no regression case is for "${agent}"`);

  /** @type {Map<string, CaseInput>} */
  const inputs = new Map();
  /** @type {Map<string, string[]>} each case's trial outputs, normalized */
  const outputs = new Map();
  for (const c of cases) {
    try {
      const input = loadInput(root, c);
      inputs.set(c.id, input);
      errors.push(...caseErrors(c, input));
    } catch (e) {
      errors.push(
        `${c.id}: its input cannot be read: ${/** @type {Error} */ (e).message}`
      );
    }
    // Every case needs all k trials, each with its output: a missing one is
    // missing work, never a smaller denominator or a silent "declined".
    /** @type {string[]} */
    const texts = [];
    for (let n = 1; n <= k; n++) {
      const file = join(trialsDir, c.id, `trial-${n}`, TRIAL_OUTPUT[c.agent]);
      if (existsSync(file) && statSync(file).isFile())
        texts.push(normalize(readFileSync(file, 'utf8')));
      else errors.push(`${c.id}: trial ${n} has no output (${file})`);
    }
    outputs.set(c.id, texts);
  }
  if (errors.length) return { ok: false, errors };

  const results = cases.map((c) => {
    const input = /** @type {CaseInput} */ (inputs.get(c.id));
    const trials = /** @type {string[]} */ (outputs.get(c.id)).map((text) => ({
      output_sha256: sha256(text),
      ...scoreTrial(c, input, text, validate),
    }));
    return caseResult(c, trials);
  });
  const agg = aggregate(results);
  const scopeAgents = [...new Set(cases.map((c) => c.agent))].sort();
  const rule = {
    ...manifest.decision_rule,
    sha256: sha256(normalize(manifestText)),
    set_tree: setTree,
  };

  const prev = previous?.doc;
  /** @type {Previous | null} */
  let previousBlock = null;
  if (previous && prev) {
    const prevIds = new Set(
      prev.cases.map((/** @type {{ id: string }} */ c) => c.id)
    );
    const now = results.map((c) => c.id);
    const added = now.filter((id) => !prevIds.has(id));
    const removed = [...prevIds].filter((id) => !now.includes(id));
    const changed = prev.decision_rule.set_tree !== rule.set_tree;
    previousBlock = {
      source: previous.source,
      pass_k: prev.aggregate.pass_k,
      cases_added: added,
      cases_removed: removed,
      set_changed: changed,
      compared: !changed && !added.length && !removed.length,
    };
  }

  return {
    ok: true,
    doc: {
      kind: 'regression-evaluation',
      schema_version: '1.0',
      generated_at: now,
      scope: {
        agent: agent ?? null,
        agents: scopeAgents,
        cases: results.length,
        trials: k,
      },
      decision_rule: rule,
      provenance: {
        model,
        harness,
        prompts: Object.fromEntries(
          scopeAgents.map((a) => [
            a,
            promptDigests(
              /** @type {Record<string, string[]>} */ (AGENT_PROMPTS)[a],
              root
            ),
          ])
        ),
      },
      aggregate: agg,
      previous: previousBlock,
      decision: decide(manifest.decision_rule, k, results, agg, previousBlock),
      cases: results,
    },
  };
}

/** The fields that do not change what an evaluation measured. */
export const NOT_MEASURED = ['generated_at', 'previous', 'decision'];

/**
 * The console report.
 * @param {any} doc
 * @returns {string[]}
 */
export function reportLines(doc) {
  const k = doc.scope.trials;
  const pct = (/** @type {Rate} */ r) =>
    r.value === null
      ? 'n/a'
      : `${r.value.toFixed(2)} [${r.wilson_95?.[0].toFixed(2)}, ${r.wilson_95?.[1].toFixed(2)}]`;
  const lines = [
    `Regression evaluation: ${doc.scope.cases} case(s) for ${doc.scope.agents.join(', ')}, ${k} trials each; model ${doc.provenance.model}, harness ${doc.provenance.harness}`,
  ];
  for (const c of doc.cases) {
    lines.push(
      `  ${c.pass_k ? 'OK ' : 'XX '}${c.id} (${c.agent}, ${c.source}): ${c.passed}/${c.trials}, pass^${k} ${c.pass_k ? 'yes' : 'no'}, pass rate ${pct(c.pass_rate)}`
    );
    for (const t of c.trial_results)
      for (const f of t.failed)
        lines.push(`        trial ${t.trial} FAIL ${f.check}: ${f.detail}`);
  }
  const a = doc.aggregate;
  lines.push(
    `Cases passing every trial (pass^${k}): ${a.pass_k.passed}/${a.pass_k.cases} = ${pct(a.pass_k)}`,
    `Trials passing: ${a.per_trial.passed}/${a.per_trial.trials} = ${pct(a.per_trial)}`
  );
  const p = doc.previous;
  if (p)
    lines.push(
      `Previous (${p.source}): pass^${k} ${p.pass_k ? pct(p.pass_k) : 'n/a'}` +
        (p.cases_added.length
          ? `; cases added ${p.cases_added.join(', ')}`
          : '') +
        (p.cases_removed.length
          ? `; cases removed ${p.cases_removed.join(', ')}`
          : '') +
        (p.set_changed ? '; the set changed since' : '') +
        (p.compared ? '' : '; its lower bound is not compared')
    );
  else lines.push('Previous: none committed for this scope.');
  lines.push(
    `Decision rule: ${doc.decision_rule.statement}`,
    `Decision: ${doc.decision.verdict.toUpperCase()}` +
      (doc.decision.reasons.length
        ? ` (${doc.decision.reasons.join('; ')})`
        : '')
  );
  return lines;
}

/**
 * The flags of a regression run, or a usage error.
 * @param {string[]} args
 * @returns {{ ok: true, trialsDir: string, agent: string | null, out: string }
 *   | { ok: false, error: string }}
 */
function parseArgs(args) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!['--regressions', '--agent', '--out'].includes(a))
      return {
        ok: false,
        error: a.startsWith('--')
          ? `${a} does not apply to --regressions (it takes --agent and --out only).`
          : `Unexpected argument "${a}".`,
      };
    if (a in flags) return { ok: false, error: `${a} is given twice.` };
    const v = args[i + 1];
    if (!v || v.startsWith('--'))
      return { ok: false, error: `${a} requires a value.` };
    flags[a] = v;
    i++;
  }
  const agent = flags['--agent'] ?? null;
  if (agent && !(agent in TRIAL_OUTPUT))
    return {
      ok: false,
      error: `--agent must be one of ${Object.keys(TRIAL_OUTPUT).join(', ')}.`,
    };
  return {
    ok: true,
    trialsDir: flags['--regressions'],
    agent,
    out: flags['--out'] ?? `${RESULTS_DIR}/${agent ?? 'all'}.json`,
  };
}

/**
 * `evaluate-agents.js --regressions <trials-dir> [--agent <name>] [--out <path>]`.
 * @param {string[]} args the command-line arguments after the script
 * @param {{ cwd?: string, env?: Record<string, string | undefined>,
 *   log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {number} the exit code: 0 pass, 1 block, 2 usage or missing work
 */
export function runRegressions(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    log = console.log,
    error = console.error,
  } = {}
) {
  const usage = (/** @type {string} */ m) => {
    error(m);
    return 2;
  };
  const flags = parseArgs(args);
  if (!flags.ok) return usage(flags.error);
  const model = (env.QAIZEN_MODEL || '').trim();
  if (!model)
    return usage(
      'Set QAIZEN_MODEL to the model that produced the trials; results without the model cannot say what they measured.'
    );

  const manifestPath = join(cwd, MANIFEST);
  if (!existsSync(manifestPath))
    return usage(`The regression set ${MANIFEST} is missing.`);
  const manifestText = readFileSync(manifestPath, 'utf8');
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(normalize(manifestText));
  } catch {
    return usage(`${MANIFEST} is not JSON.`);
  }
  const valid = validateValue(
    manifest,
    schemaFile('regression-set.schema.json')
  );
  if (!valid.ok)
    return usage(
      `${MANIFEST} does not validate against schemas/regression-set.schema.json:\n${formatErrors(valid.errors).join('\n')}`
    );
  const committed = setCommitted(cwd);
  if (!committed.ok) return usage(committed.reason);
  const trialsDir = resolve(cwd, flags.trialsDir);
  if (!existsSync(trialsDir))
    return usage(`Trials directory not found: ${flags.trialsDir}`);

  const outPath = resolve(cwd, flags.out);
  const prior = committedResults(cwd, outPath);
  if (!prior.ok) return usage(prior.reason);
  if (prior.source !== null && (prior.doc.scope.agent ?? null) !== flags.agent)
    return usage(
      `${prior.source} is a regression evaluation of another scope; pass another --out.`
    );

  const result = evaluateSet({
    root: cwd,
    manifest,
    manifestText,
    setTree: committed.tree,
    trialsDir,
    agent: flags.agent,
    previous: prior.source === null ? null : prior,
    model,
    harness: (env.QAIZEN_HARNESS || '').trim() || UNKNOWN,
    now: new Date().toISOString(),
    validate: (v, name) => {
      const r = validateValue(v, schemaFile(name));
      return r.ok
        ? { ok: true, detail: '' }
        : {
            ok: false,
            detail:
              formatErrors(r.errors, { includeParams: false })[0] ?? r.message,
          };
    },
  });
  if (!result.ok) {
    for (const e of result.errors) error(e);
    return 2;
  }
  const checked = validateValue(
    result.doc,
    schemaFile('regression-results.schema.json')
  );
  if (!checked.ok)
    return usage(
      `The results do not validate against schemas/regression-results.schema.json; nothing was written:\n${formatErrors(checked.errors).join('\n')}`
    );

  // A re-run that measured the same thing keeps the recorded file, with its
  // date and decision.
  const { written, recorded } = writeResultsIfChanged(outPath, result.doc, {
    ignore: NOT_MEASURED,
  });
  const doc = recorded ?? result.doc;
  for (const line of reportLines(doc)) log(line);
  log(
    written
      ? `  wrote ${flags.out}`
      : `  unchanged: ${flags.out} already records these results (recorded ${recorded.generated_at}); it was not rewritten.`
  );
  return doc.decision.verdict === 'pass' ? 0 : 1;
}
