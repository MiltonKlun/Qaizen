#!/usr/bin/env node
// Structural evaluation of the Analyst and Test Designer outputs (Phase 2
// TG11; reworked in task group 8.1, review finding I5).
//
// Two modes, and they answer different questions:
//
//   * Expected fixture validation (default). Scores the committed GOLD
//     outputs in examples/expected/ against the structural invariants: schema
//     validity, required fields, ID patterns, TC -> RISK and TC -> AC links,
//     automation decision with a reason, risk coverage. This checks the
//     fixtures. It does NOT evaluate a prompt: nothing here reads a prompt or
//     runs an agent, so a prompt edit cannot change its result.
//
//   * Candidate evaluation (--candidate-dir). Scores a run that an agent
//     produced from one of the fixed stories with the prompt under review,
//     records that prompt's version and content digest, and compares the
//     candidate with a baseline (a previous results file, or the story's gold
//     output). This is the step of the human prompt-change workflow
//     (docs/prompt-versioning.md) where the model's output is evaluated.
//
// Which gold outputs exist is declared, not guessed: examples/evaluation/
// manifest.json (schemas/evaluation-manifest.schema.json) lists every story
// as `designer` (context + test cases), `analyst` (context only) or `none`
// (no gold output yet, with a reason). A story missing from the manifest, or a
// declared output that is missing, fails: missing work is reported as missing,
// never dropped from the denominator. An Analyst-only story is labelled as
// such and never counts as a tested Designer output.
//
// Scores are structural. Wording similarity is not measured, and a
// structural 100% says nothing about whether the business interpretation is
// right; that is judged with the review-gate rubrics (docs/review-gates.md).
//
// Usage:
//   npm run evaluate                                   # expected fixture validation
//   node scripts/evaluate-agents.js --candidate-dir <run-dir> [--stage analyst|designer]
//     [--baseline <results.json>]                      # candidate evaluation
//   node scripts/evaluate-agents.js --out <path>       # write results elsewhere
//
// Output: examples/evaluation/latest-results.json in fixture mode;
// <run-dir>/evaluation-results.json in candidate mode, so the candidate's
// evidence stays with the candidate (or --out <path>).
//
// Exit codes: 0 every scored check passed · 1 at least one check failed
//             · 2 usage error, invalid manifest, or missing declared/requested work

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { readValidatedJson, validateValue } from './lib/artifact-io.js';

const STORIES_DIR = 'examples/stories';
const EXPECTED_DIR = 'examples/expected';
const MANIFEST = 'examples/evaluation/manifest.json';
const AGENTS_DIR = 'agents';
const DEFAULT_OUT_FILE = 'examples/evaluation/latest-results.json';

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas'
);
const schema = (name) => join(SCHEMA_DIR, name);
const CONTEXT_SCHEMA = schema('context.schema.json');
const TEST_CASES_SCHEMA = schema('test-cases.schema.json');
const MANIFEST_SCHEMA = schema('evaluation-manifest.schema.json');

/** The agents whose outputs each stage evaluates. */
const STAGE_AGENTS = {
  analyst: ['analyst'],
  designer: ['analyst', 'test-designer'],
};

/** Drop the documented "needs rework" signal fires at (percentage points). */
const REGRESSION_POINTS = 10;

function fail(message) {
  console.error(message);
  exit(2);
}

// ---------------------------------------------------------------- flags --
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  // A flag given with no value (or followed by another flag) is a usage
  // error, never an invitation to fall back silently to another mode.
  if (!v || v.startsWith('--')) return null;
  return v;
}

const candidateDir = flagValue('--candidate-dir');
if (candidateDir === null) fail('--candidate-dir requires a directory path.');
const stageFlag = flagValue('--stage');
if (stageFlag === null || (stageFlag && !STAGE_AGENTS[stageFlag])) {
  fail(
    `--stage must be "analyst" or "designer" (got ${stageFlag ? `"${stageFlag}"` : 'no value'}).`
  );
}
if (stageFlag && !candidateDir)
  fail('--stage applies to --candidate-dir runs only.');
const STAGE = stageFlag || 'designer';
const baselinePath = flagValue('--baseline');
if (baselinePath === null) fail('--baseline requires a results file path.');
if (baselinePath && !candidateDir) {
  fail('--baseline applies to --candidate-dir runs only.');
}
const outFlag = flagValue('--out');
if (outFlag === null) fail('--out requires a path.');
const OUT_FILE =
  outFlag ||
  (candidateDir
    ? join(candidateDir, 'evaluation-results.json')
    : DEFAULT_OUT_FILE);

// ---------------------------------------------------------------- checks --
const STORY_ID_RE = /^(STORY-[0-9]+|[A-Z][A-Z0-9_]*-[0-9]+)$/;
const RISK_ID_RE = /^RISK-[0-9]+$/;
const TC_ID_RE = /^TC-[0-9]+$/;
const AUTOMATION_DECISIONS = [
  'automate_e2e',
  'automate_api',
  'automate_component',
  'manual',
  'skip',
];

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** First schema error as `path message`, for a check's detail. */
function schemaDetail(v) {
  const e = (v.errors ?? [])[0];
  return e ? `${e.instancePath || '(root)'} ${e.message}` : '';
}

// One check = { name, pass, detail }. A story's score is passed/total.
function checkContext(ctx) {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });

  const valid = validateValue(ctx, CONTEXT_SCHEMA);
  add('context validates against its schema', valid.ok, schemaDetail(valid));

  const REQUIRED = [
    'schema_version',
    'run_id',
    'story',
    'acceptance_criteria',
    'ambiguities',
    'risks',
    'artifact_paths',
    'review_gates',
    'status',
  ];
  for (const k of REQUIRED) {
    add(`context.${k} present`, ctx[k] !== undefined);
  }

  const story = ctx.story || {};
  add('story.id matches pattern', STORY_ID_RE.test(story.id || ''), story.id);
  add(
    'story.source is manual|jira',
    ['manual', 'jira'].includes(story.source),
    story.source
  );
  add(
    'jira source has jira_issue_key == id',
    story.source !== 'jira' ||
      (story.jira_issue_key && story.jira_issue_key === story.id),
    story.source === 'jira' ? story.jira_issue_key : '(n/a)'
  );

  add(
    'acceptance_criteria non-empty',
    Array.isArray(ctx.acceptance_criteria) && ctx.acceptance_criteria.length > 0
  );

  const risks = Array.isArray(ctx.risks) ? ctx.risks : [];
  add('at least one risk', risks.length > 0);
  const acCount = (ctx.acceptance_criteria || []).length;
  let riskOk = true;
  let riskDetail = '';
  for (const r of risks) {
    if (!RISK_ID_RE.test(r.risk_id || '')) {
      riskOk = false;
      riskDetail = `bad risk_id ${r.risk_id}`;
      break;
    }
    if (!['low', 'medium', 'high'].includes(r.severity)) {
      riskOk = false;
      riskDetail = `bad severity on ${r.risk_id}`;
      break;
    }
    // related_acs must index into acceptance_criteria.
    for (const idx of r.related_acs || []) {
      if (typeof idx !== 'number' || idx < 0 || idx >= acCount) {
        riskOk = false;
        riskDetail = `${r.risk_id}.related_acs[${idx}] out of range`;
        break;
      }
    }
    if (!riskOk) break;
  }
  add(
    'risks well-formed (id, severity, related_acs in range)',
    riskOk,
    riskDetail
  );

  return checks;
}

function checkTestCases(tcDoc, ctx) {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });

  const valid = validateValue(tcDoc, TEST_CASES_SCHEMA);
  add(
    'test cases validate against their schema',
    valid.ok,
    schemaDetail(valid)
  );

  add('test_cases array present', Array.isArray(tcDoc.test_cases));
  const cases = Array.isArray(tcDoc.test_cases) ? tcDoc.test_cases : [];
  add('at least one test case', cases.length > 0);

  add(
    'story_id matches context.story.id',
    tcDoc.story_id === (ctx.story || {}).id,
    `${tcDoc.story_id} vs ${(ctx.story || {}).id}`
  );

  const riskIds = new Set((ctx.risks || []).map((r) => r.risk_id));
  const acCount = (ctx.acceptance_criteria || []).length;

  let idsOk = true;
  let linkOk = true;
  let acOk = true;
  let decisionOk = true;
  let detailId = '';
  let detailLink = '';
  let detailAc = '';
  let detailDec = '';
  const coveredRisks = new Set();

  for (const tc of cases) {
    if (!TC_ID_RE.test(tc.test_case_id || '')) {
      idsOk = false;
      detailId = `bad test_case_id ${tc.test_case_id}`;
    }
    // TC -> RISK linkage: every risk_id must exist in context.risks.
    const links = tc.risk_ids || [];
    if (links.length === 0) {
      linkOk = false;
      detailLink = `${tc.test_case_id} has no risk_ids`;
    }
    for (const rid of links) {
      if (!riskIds.has(rid)) {
        linkOk = false;
        detailLink = `${tc.test_case_id} references unknown ${rid}`;
      } else {
        coveredRisks.add(rid);
      }
    }
    // TC -> AC linkage: every reference must index a real acceptance criterion.
    for (const idx of tc.acceptance_criteria_refs || []) {
      if (typeof idx !== 'number' || idx < 0 || idx >= acCount) {
        acOk = false;
        detailAc = `${tc.test_case_id}.acceptance_criteria_refs[${idx}] out of range`;
      }
    }
    // automation_decision present + non-empty reason.
    if (!AUTOMATION_DECISIONS.includes(tc.automation_decision)) {
      decisionOk = false;
      detailDec = `${tc.test_case_id} bad automation_decision ${tc.automation_decision}`;
    }
    if (
      !tc.automation_decision_reason ||
      String(tc.automation_decision_reason).trim().length === 0
    ) {
      decisionOk = false;
      detailDec = `${tc.test_case_id} empty automation_decision_reason`;
    }
  }

  add('all test_case_id match TC-XXX', idsOk, detailId);
  add('every TC links to a real RISK', linkOk, detailLink);
  add('every TC acceptance_criteria_ref is a real AC', acOk, detailAc);
  add('every TC has a decision + non-empty reason', decisionOk, detailDec);

  // Every risk in context is covered by at least one TC.
  const uncovered = [...riskIds].filter((r) => !coveredRisks.has(r));
  add(
    'every context risk is covered by a TC',
    uncovered.length === 0,
    uncovered.join(', ')
  );

  return checks;
}

/**
 * Match percentage, floored to one decimal: 199/200 is 99.5, never a rounded
 * 100. Null when nothing was checked (an empty score is not a score).
 */
function matchPct(passed, total) {
  return total > 0 ? Math.floor((passed * 1000) / total) / 10 : null;
}

function score(story, stage, ctx, ctxPath, tcDoc, tcPath) {
  const checks = [...checkContext(ctx)];
  if (stage === 'designer') checks.push(...checkTestCases(tcDoc, ctx));
  const passed = checks.filter((c) => c.pass).length;
  return {
    story,
    stage,
    sources: { context: ctxPath, test_cases: tcPath ?? null },
    checks,
    failed_checks: checks
      .filter((c) => !c.pass)
      .map((c) => ({ name: c.name, detail: c.detail })),
    passed,
    total: checks.length,
    match_pct: matchPct(passed, checks.length),
  };
}

// -------------------------------------------------------------- manifest --
if (!existsSync(STORIES_DIR)) fail(`Stories dir not found: ${STORIES_DIR}`);
const manifestRead = readValidatedJson(MANIFEST, MANIFEST_SCHEMA);
if (!manifestRead.ok) {
  fail(
    `The evaluation manifest ${MANIFEST} is missing or invalid (schemas/evaluation-manifest.schema.json): ` +
      `${manifestRead.message}. It declares which gold outputs each story has.`
  );
}
const manifest = manifestRead.data.stories;
{
  const listed = manifest.map((s) => s.story);
  const dup = listed.find((s, i) => listed.indexOf(s) !== i);
  if (dup) fail(`${MANIFEST} lists "${dup}" more than once.`);
  const files = readdirSync(STORIES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  const unlisted = files.filter((f) => !listed.includes(f)).sort();
  const orphaned = listed.filter((s) => !files.includes(s)).sort();
  if (unlisted.length || orphaned.length) {
    fail(
      [
        `${MANIFEST} does not match ${STORIES_DIR}/:`,
        ...unlisted.map(
          (s) =>
            `  - ${s}.md has no manifest entry (declare designer, analyst or none)`
        ),
        ...orphaned.map(
          (s) =>
            `  - "${s}" is listed but ${STORIES_DIR}/${s}.md does not exist`
        ),
      ].join('\n')
    );
  }
}
const byStory = [...manifest].sort((a, b) => a.story.localeCompare(b.story));
const goldPaths = (story) => ({
  ctx: `${EXPECTED_DIR}/${story}.expected-context.json`,
  tc: `${EXPECTED_DIR}/${story}.expected-test-cases.json`,
});

/** The gold output a manifest entry declares, scored at `stage` (or a reason it cannot be). */
function scoreGold(entry, stage) {
  const p = goldPaths(entry.story);
  if (!existsSync(p.ctx))
    return { missing: `${p.ctx} is declared but missing` };
  if (stage === 'designer' && !existsSync(p.tc)) {
    return { missing: `${p.tc} is declared but missing` };
  }
  return {
    result: score(
      entry.story,
      stage,
      loadJson(p.ctx),
      p.ctx,
      stage === 'designer' ? loadJson(p.tc) : null,
      stage === 'designer' ? p.tc : null
    ),
  };
}

// ---------------------------------------------------------- prompt identity --
/** An agent prompt's frontmatter version and content digest (line endings normalized). */
function promptIdentity(name) {
  const path = join(AGENTS_DIR, `${name}.md`);
  if (!existsSync(path)) return { path, version: null, sha256: null };
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const version =
    /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(text)?.[1] ?? null;
  return {
    path,
    version,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/** The story id a fixed story stands for: its gold context, else its title line. */
function storyIdOf(entry) {
  const p = goldPaths(entry.story);
  if (existsSync(p.ctx)) return loadJson(p.ctx).story?.id ?? null;
  const first = readFileSync(
    join(STORIES_DIR, `${entry.story}.md`),
    'utf8'
  ).split('\n')[0];
  return /\(([A-Z][A-Z0-9_]*-[0-9]+)\)\s*$/.exec(first)?.[1] ?? null;
}

// ------------------------------------------------------------- comparison --
function compare(candidate, baseline) {
  const was = new Map(baseline.checks.map((c) => [c.name, c.pass]));
  const now = new Map(candidate.checks.map((c) => [c.name, c.pass]));
  const regressions = [...was]
    .filter(([n, p]) => p && now.get(n) === false)
    .map(([n]) => n);
  const fixes = [...was]
    .filter(([n, p]) => !p && now.get(n) === true)
    .map(([n]) => n);
  const notInBaseline = [...now.keys()].filter((n) => !was.has(n));
  const delta =
    candidate.match_pct !== null && baseline.match_pct !== null
      ? Math.round((candidate.match_pct - baseline.match_pct) * 10) / 10
      : null;
  return {
    regressions,
    fixes,
    not_in_baseline: notInBaseline,
    match_pct_delta: delta,
    needs_rework_signal: delta !== null && delta < -REGRESSION_POINTS,
  };
}

// ------------------------------------------------------------------ run ---
const results = [];
const missing = [];
const excluded = [];
let candidate = null;
let baseline = null;

if (!candidateDir) {
  for (const entry of byStory) {
    if (entry.expected === 'none') {
      excluded.push({ story: entry.story, reason: entry.reason });
      continue;
    }
    const g = scoreGold(entry, entry.expected);
    if (g.missing) {
      missing.push({
        story: entry.story,
        stage: entry.expected,
        reason: g.missing,
      });
      continue;
    }
    results.push({
      ...g.result,
      ...(entry.reason ? { note: entry.reason } : {}),
    });
  }
} else {
  // A requested candidate that does not exist is an ERROR, never an empty
  // cohort that quietly scores 100% (review finding I5).
  if (!existsSync(candidateDir))
    fail(`Candidate directory not found: ${candidateDir}`);
  const ctxPath = join(candidateDir, 'context.json');
  if (!existsSync(ctxPath)) fail(`Candidate has no context.json: ${ctxPath}`);
  let ctx;
  try {
    ctx = loadJson(ctxPath);
  } catch {
    fail(`Candidate context is not valid JSON: ${ctxPath}`);
  }
  const id = ctx.story?.id;
  // Candidates are generated from the FIXED stories, so a result can be
  // compared with a baseline for the same story.
  const entry = byStory.find((e) => storyIdOf(e) === id);
  if (!entry) {
    fail(
      `Candidate story ${id ?? '(no story.id)'} is not one of the fixed evaluation stories in ${MANIFEST}.`
    );
  }
  const tcPath = join(candidateDir, 'test-cases', `${id}.json`);
  // Designer stage (the default) scores the Test Designer's output too, so a
  // missing test-cases file is missing WORK, not a reason to score the context
  // alone and report a perfect match.
  if (STAGE === 'designer' && !existsSync(tcPath)) {
    fail(
      `Candidate is missing required test cases for designer stage: ${tcPath}\n` +
        'Pass --stage analyst to evaluate a deliberate Analyst-only run.'
    );
  }

  // The prompts under evaluation, by version and content digest. A candidate
  // that recorded other prompt versions was not produced by these prompts.
  const prompts = {};
  for (const name of STAGE_AGENTS[STAGE]) {
    const p = promptIdentity(name);
    const recorded = ctx.prompt_versions?.[name] ?? null;
    if (recorded && p.version && recorded !== p.version) {
      fail(
        `Candidate was produced with ${name} ${recorded}, but ${p.path} is ${p.version}. ` +
          'Evaluate a candidate against the prompt that produced it.'
      );
    }
    prompts[name] = { ...p, recorded_by_candidate: recorded };
  }

  const result = score(
    entry.story,
    STAGE,
    ctx,
    ctxPath,
    STAGE === 'designer' ? loadJson(tcPath) : null,
    STAGE === 'designer' ? tcPath : null
  );
  results.push(result);
  candidate = {
    dir: candidateDir,
    story: entry.story,
    story_id: id,
    stage: STAGE,
    prompts,
  };

  if (baselinePath) {
    if (!existsSync(baselinePath))
      fail(`Baseline results not found: ${baselinePath}`);
    let base;
    try {
      base = loadJson(baselinePath);
    } catch {
      fail(`Baseline results are not valid JSON: ${baselinePath}`);
    }
    const prior = (base.results ?? []).find(
      (r) => r.story === entry.story && Array.isArray(r.checks)
    );
    if (!prior)
      fail(`Baseline ${baselinePath} has no result for ${entry.story}.`);
    baseline = {
      source: baselinePath,
      stage: prior.stage ?? null,
      match_pct: prior.match_pct ?? null,
      ...compare(result, prior),
    };
  } else if (entry.expected !== 'none') {
    // The story's gold output, scored at the stages both have.
    const stage =
      STAGE === 'designer' && entry.expected === 'designer'
        ? 'designer'
        : 'analyst';
    const g = scoreGold(entry, stage);
    if (g.missing)
      fail(`The gold baseline for ${entry.story} is missing: ${g.missing}`);
    baseline = {
      source: `gold:${entry.story} (${stage})`,
      stage,
      match_pct: g.result.match_pct,
      ...compare(result, g.result),
    };
  }
}

const passedChecks = results.reduce((a, r) => a + r.passed, 0);
const totalChecks = results.reduce((a, r) => a + r.total, 0);
const count = (stage) => results.filter((r) => r.stage === stage).length;
const declared = (stage) => byStory.filter((e) => e.expected === stage).length;

const out = {
  generated_at: new Date().toISOString(),
  kind: candidateDir ? 'candidate-evaluation' : 'expected-fixture-validation',
  scope:
    'structural: schema validity, required fields, ids, TC->RISK and TC->AC links, decisions, risk coverage. ' +
    'Not wording, and not business correctness (judged with the review-gate rubrics).',
  counts: candidateDir
    ? { requested: 1, scored: results.length }
    : {
        stories: byStory.length,
        declared: {
          designer: declared('designer'),
          analyst: declared('analyst'),
          none: declared('none'),
        },
        scored: { designer: count('designer'), analyst: count('analyst') },
        missing: missing.length,
      },
  checks: { passed: passedChecks, total: totalChecks },
  match_pct: matchPct(passedChecks, totalChecks),
  missing,
  excluded,
  ...(candidate ? { candidate } : {}),
  ...(baseline ? { baseline } : {}),
  results,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');

// ---------------------------------------------------------------- console --
const pctText = (p) => (p === null ? 'n/a' : `${p}%`);
console.log(
  candidateDir
    ? `Candidate evaluation: ${candidateDir} (${candidate.story}, ${STAGE} stage)`
    : 'Expected fixture validation: the committed gold outputs (this does not evaluate prompt behavior)'
);
if (candidate) {
  for (const [name, p] of Object.entries(candidate.prompts)) {
    console.log(
      `  prompt ${name} ${p.version ?? '(no version)'} sha256:${p.sha256 ? p.sha256.slice(0, 12) : '(missing)'}` +
        (p.recorded_by_candidate
          ? ''
          : '  (the candidate did not record its prompt version)')
    );
  }
} else {
  const c = out.counts;
  console.log(
    `  Stories: ${c.stories} | declared designer ${c.declared.designer}, analyst-only ${c.declared.analyst}, ` +
      `no gold ${c.declared.none} | scored designer ${c.scored.designer}, analyst-only ${c.scored.analyst} | missing ${c.missing}`
  );
}
for (const r of results) {
  const tag = r.passed === r.total ? 'OK ' : 'XX ';
  const label =
    r.stage === 'analyst'
      ? ' [analyst-only: not a tested Designer output]'
      : '';
  console.log(
    `  ${tag}${r.story}: ${pctText(r.match_pct)} (${r.passed}/${r.total})${label}`
  );
  for (const f of r.failed_checks) {
    console.log(`        FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
}
for (const m of missing)
  console.log(`  MISSING ${m.story} (${m.stage}): ${m.reason}`);
for (const e of excluded)
  console.log(`  - ${e.story}: no gold output (${e.reason})`);
if (baseline) {
  console.log(
    `  Baseline ${baseline.source}: ${pctText(baseline.match_pct)} -> ${pctText(results[0].match_pct)}` +
      (baseline.match_pct_delta === null
        ? ''
        : ` (${baseline.match_pct_delta >= 0 ? '+' : ''}${baseline.match_pct_delta} points)`)
  );
  for (const n of baseline.regressions) console.log(`        REGRESSED: ${n}`);
  for (const n of baseline.fixes) console.log(`        FIXED: ${n}`);
  if (baseline.needs_rework_signal) {
    console.log(
      `  WARNING: the match dropped by more than ${REGRESSION_POINTS} points: the documented "needs rework" signal (docs/prompt-versioning.md).`
    );
  }
} else if (candidate) {
  console.log(
    '  No baseline: this story has no gold output; pass --baseline <results.json>.'
  );
}
console.log(
  `\nOverall: ${pctText(out.match_pct)} (${passedChecks}/${totalChecks} checks)  ->  wrote ${OUT_FILE}`
);
console.log(
  '  Structural only: a 100% is not a verdict on the business interpretation.'
);

// Missing declared work, or an empty cohort, is a failure, never a pass
// (review finding I5).
if (missing.length) {
  console.error(
    `${missing.length} declared gold output(s) are missing (listed above).`
  );
  exit(2);
}
if (results.length === 0) {
  console.error(
    'Nothing was scored: the manifest declares no gold output to evaluate.'
  );
  exit(2);
}
exit(passedChecks === totalChecks ? 0 : 1);
