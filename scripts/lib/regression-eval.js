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
// uncommitted changes, so the rule and the cases that judged a change are in
// history before the results they produced. The results go to
// evidence/regressions/<agent|all>.json and are rewritten only when they
// change; the previous results there are what "previous" means in the rule.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatErrors,
  readValidatedJson,
  validateValue,
} from './artifact-io.js';

import { promptDigests, STEP_PROMPTS, UNKNOWN } from './provenance.js';
import { CHECKS, TRIAL_OUTPUT } from './regression-checks.js';
import { sameRecorded, writeResultsIfChanged } from './results-file.js';

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas'
);
const schemaFile = (/** @type {string} */ name) => join(SCHEMA_DIR, name);

export const SET_DIR = 'examples/evaluation/regressions';
export const MANIFEST = `${SET_DIR}/manifest.json`;
export const RESULTS_DIR = 'evidence/regressions';

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
 */

const round4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
const sha256 = (/** @type {string} */ s) =>
  createHash('sha256').update(s).digest('hex');
const normalize = (/** @type {string} */ s) => s.replace(/\r\n/g, '\n');

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
 * @param {string | null} text the output file's text, null when absent
 * @param {(value: any, schema: string) => { ok: boolean, detail: string }} validate
 */
export function scoreTrial(c, input, text, validate) {
  /** @type {any} */
  let json;
  if (text !== null) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
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
 * @param {{ output_sha256: string | null, pass: boolean,
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
 * The decision the rule gives.
 * @param {DecisionRule} rule
 * @param {number} k
 * @param {ReturnType<typeof caseResult>[]} cases
 * @param {ReturnType<typeof aggregate>} agg
 * @param {{ pass_k: Rate } | null} previous
 * @returns {{ verdict: 'pass' | 'block', reasons: string[] }}
 */
export function decide(rule, k, cases, agg, previous) {
  /** @type {string[]} */
  const reasons = [];
  if (rule.block_when_a_case_fails_every_trial)
    for (const c of cases)
      if (c.passed === 0) reasons.push(`${c.id} failed all ${k} trials`);
  const bound = previous?.pass_k?.wilson_95?.[0];
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
 * Whether the set (rule, cases, inputs) is committed as it is on disk.
 * @param {string} root
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function setCommitted(root) {
  const r = spawnSync('git', ['status', '--porcelain', '--', SET_DIR], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0)
    return {
      ok: false,
      reason:
        'cannot ask git whether the regression set is committed (not a git work tree?)',
    };
  if (r.stdout.trim())
    return {
      ok: false,
      reason: `${SET_DIR} has uncommitted changes:\n${r.stdout.trimEnd()}\nCommit the decision rule and the cases before the run, so they are in history before the results they judge.`,
    };
  return { ok: true };
}

/**
 * Score a set of trials.
 * @param {{
 *   root: string,
 *   manifest: { trials: number, decision_rule: DecisionRule,
 *     cases: RegressionCase[] },
 *   manifestText: string,
 *   trialsDir: string,
 *   agent: string | null,
 *   previous: { source: string, doc: any } | null,
 *   env: Record<string, string | undefined>,
 *   now: string,
 *   validate: (value: any, schema: string) => { ok: boolean, detail: string },
 * }} args
 * @returns {{ ok: false, errors: string[] } | { ok: true, doc: any }}
 */
export function evaluateSet({
  root,
  manifest,
  manifestText,
  trialsDir,
  agent,
  previous,
  env,
  now,
  validate,
}) {
  const k = manifest.trials;
  const cases = manifest.cases.filter((c) => !agent || c.agent === agent);
  if (!cases.length)
    return { ok: false, errors: [`no regression case is for "${agent}"`] };

  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, CaseInput>} */
  const inputs = new Map();
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
  }
  // Every case needs all k trials: a missing one is missing work, never a
  // smaller denominator.
  for (const c of cases)
    for (let n = 1; n <= k; n++) {
      const dir = join(trialsDir, c.id, `trial-${n}`);
      const isDir = existsSync(dir) && statSync(dir).isDirectory();
      if (!isDir) errors.push(`${c.id}: trial ${n} is missing (${dir})`);
      else if (
        c.agent !== 'healer' &&
        !existsSync(join(dir, TRIAL_OUTPUT[c.agent]))
      )
        errors.push(
          `${c.id}: trial ${n} has no ${TRIAL_OUTPUT[c.agent]} (${dir})`
        );
    }
  if (errors.length) return { ok: false, errors };

  const results = cases.map((c) => {
    const input = /** @type {CaseInput} */ (inputs.get(c.id));
    const trials = [];
    for (let n = 1; n <= k; n++) {
      const file = join(trialsDir, c.id, `trial-${n}`, TRIAL_OUTPUT[c.agent]);
      const text = existsSync(file)
        ? normalize(readFileSync(file, 'utf8'))
        : null;
      trials.push({
        output_sha256: text === null ? null : sha256(text),
        ...scoreTrial(c, input, text, validate),
      });
    }
    return caseResult(c, trials);
  });
  const agg = aggregate(results);
  const scopeAgents = [...new Set(cases.map((c) => c.agent))].sort();

  const prev = previous?.doc;
  const prevIds = new Set(
    (prev?.cases ?? []).map((/** @type {{ id: string }} */ c) => c.id)
  );
  const ids = results.map((c) => c.id);
  const rule = {
    ...manifest.decision_rule,
    sha256: sha256(normalize(manifestText)),
  };
  const previousBlock = prev
    ? {
        source: /** @type {{ source: string }} */ (previous).source,
        pass_k: prev.aggregate?.pass_k ?? null,
        cases_added: ids.filter((id) => !prevIds.has(id)),
        cases_removed: [...prevIds].filter((id) => !ids.includes(id)),
        set_changed: prev.decision_rule?.sha256 !== rule.sha256,
      }
    : null;

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
        model: (env.QAIZEN_MODEL || '').trim() || UNKNOWN,
        harness: (env.QAIZEN_HARNESS || '').trim() || UNKNOWN,
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
 * The results already recorded at `path`, when they measured the same thing:
 * a re-run on the same outputs keeps them, with their date and decision.
 * @param {string} path
 * @param {any} doc
 */
export const recordedSame = (path, doc) =>
  sameRecorded(path, doc, NOT_MEASURED);

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
  if (doc.previous) {
    const p = doc.previous;
    lines.push(
      `Previous (${p.source}): pass^${k} ${p.pass_k ? pct(p.pass_k) : 'n/a'}` +
        (p.cases_added.length
          ? `; cases added ${p.cases_added.join(', ')}`
          : '') +
        (p.cases_removed.length
          ? `; cases removed ${p.cases_removed.join(', ')}`
          : '') +
        (p.set_changed ? '; the set or its rule changed since' : '')
    );
  } else lines.push('Previous: none recorded for this scope.');
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
  const value = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    return !v || v.startsWith('--') ? null : v;
  };
  const known = new Set(['--regressions', '--agent', '--out']);
  const other = args.find((a) => a.startsWith('--') && !known.has(a));
  if (other)
    return usage(
      `${other} does not apply to --regressions (it takes --agent and --out only).`
    );
  const trialsDir = value('--regressions');
  if (!trialsDir) return usage('--regressions requires a trials directory.');
  const agent = value('--agent');
  if (agent === null || (agent && !(agent in TRIAL_OUTPUT)))
    return usage(
      `--agent must be one of ${Object.keys(TRIAL_OUTPUT).join(', ')}.`
    );
  const outFlag = value('--out');
  if (outFlag === null) return usage('--out requires a path.');
  const out = outFlag ?? `${RESULTS_DIR}/${agent ?? 'all'}.json`;

  const read = readValidatedJson(
    join(cwd, MANIFEST),
    schemaFile('regression-set.schema.json')
  );
  if (!read.ok)
    return usage(
      `The regression set ${MANIFEST} is missing or invalid (schemas/regression-set.schema.json): ${read.message}\n${formatErrors(read.errors).join('\n')}`
    );
  const ids = read.data.cases.map((/** @type {{ id: string }} */ c) => c.id);
  const dup = ids.find(
    (/** @type {string} */ id, /** @type {number} */ i) => ids.indexOf(id) !== i
  );
  if (dup) return usage(`${MANIFEST} lists ${dup} more than once.`);
  const committed = setCommitted(cwd);
  if (!committed.ok) return usage(committed.reason);
  const trials = resolve(cwd, trialsDir);
  if (!existsSync(trials))
    return usage(`Trials directory not found: ${trialsDir}`);

  const outPath = resolve(cwd, out);
  /** @type {{ source: string, doc: any } | null} */
  let previous = null;
  if (existsSync(outPath)) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(outPath, 'utf8'));
    } catch {
      return usage(
        `${out} exists but is not JSON; it cannot be the previous results.`
      );
    }
    if (
      doc?.kind !== 'regression-evaluation' ||
      (doc.scope?.agent ?? null) !== (agent ?? null)
    )
      return usage(
        `${out} is not a regression evaluation of the same scope (${agent ?? 'all agents'}); pass another --out.`
      );
    previous = { source: out, doc };
  }

  const result = evaluateSet({
    root: cwd,
    manifest: read.data,
    manifestText: readFileSync(join(cwd, MANIFEST), 'utf8'),
    trialsDir: trials,
    agent: agent ?? null,
    previous,
    env,
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
  const valid = validateValue(
    result.doc,
    schemaFile('regression-results.schema.json')
  );
  if (!valid.ok)
    return usage(
      `The results do not validate against schemas/regression-results.schema.json; nothing was written:\n${formatErrors(valid.errors).join('\n')}`
    );

  const recorded = recordedSame(outPath, result.doc);
  const doc = recorded ?? result.doc;
  for (const line of reportLines(doc)) log(line);
  if (recorded)
    log(
      `  unchanged: ${out} already records these results (recorded ${recorded.generated_at}); it was not rewritten.`
    );
  else {
    writeResultsIfChanged(outPath, result.doc, { ignore: NOT_MEASURED });
    log(`  wrote ${out}`);
  }
  if (doc.provenance.model === UNKNOWN)
    log(
      '  The model is unknown: set QAIZEN_MODEL to the model that produced the trials.'
    );
  return doc.decision.verdict === 'pass' ? 0 : 1;
}
