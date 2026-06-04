#!/usr/bin/env node
// Agent evaluation harness (Phase 2 TG11). For each story in
// examples/stories/, checks the matching expected outputs in
// examples/expected/ against the STRUCTURAL invariants the Analyst and
// Test Designer must satisfy — required fields, ID patterns, TC -> RISK
// linkage, and automation_decision-with-reason. It compares STRUCTURE,
// not wording: two valid runs phrase ACs and risks differently but must
// share the same shape and linkage.
//
// Why structural, not a live agent run: the agents are LLM-driven and
// cannot be invoked headlessly in CI. So the harness scores the gold
// expected outputs (the bar a run is held to) and — when you point it at
// a fresh agent run with --candidate-dir <dir> — scores that run's
// context.json / test-cases/<id>.json against the SAME invariants. That
// is the "evaluate a prompt change before adoption" loop the plan calls
// for (phase2 TG11): regenerate outputs, run this, compare the match %.
//
// Usage:
//   node scripts/evaluate-agents.js                 # score expected/ (the dataset)
//   node scripts/evaluate-agents.js --candidate-dir runs/STORY-003  # score a run
//
// Output: examples/evaluation/latest-results.json + a per-story summary.
//
// Exit codes: 0 every story scored 100% · 1 at least one check failed
//             · 2 usage / read error

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { argv, exit } from 'node:process';

const STORIES_DIR = 'examples/stories';
const EXPECTED_DIR = 'examples/expected';
const OUT_DIR = 'examples/evaluation';
const OUT_FILE = `${OUT_DIR}/latest-results.json`;

const candIdx = argv.indexOf('--candidate-dir');
const candidateDir = candIdx !== -1 ? argv[candIdx + 1] : null;

if (!existsSync(STORIES_DIR)) {
  console.error(`Stories dir not found: ${STORIES_DIR}`);
  exit(2);
}

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

// One check = { name, pass, detail }. A story's score is passed/total.
function checkContext(ctx) {
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass, detail });

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

  add('test_cases array present', Array.isArray(tcDoc.test_cases));
  const cases = Array.isArray(tcDoc.test_cases) ? tcDoc.test_cases : [];
  add('at least one test case', cases.length > 0);

  add(
    'story_id matches context.story.id',
    tcDoc.story_id === (ctx.story || {}).id,
    `${tcDoc.story_id} vs ${(ctx.story || {}).id}`
  );

  const riskIds = new Set((ctx.risks || []).map((r) => r.risk_id));

  let idsOk = true;
  let linkOk = true;
  let decisionOk = true;
  let detailId = '';
  let detailLink = '';
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

// Resolve the context + test-cases files for a story. Default source is
// examples/expected/<base>.expected-*.json; with --candidate-dir, look for
// a fresh run's context.json + test-cases/<story-id>.json.
function resolveFor(base) {
  if (candidateDir) {
    const ctxPath = `${candidateDir}/context.json`;
    if (!existsSync(ctxPath)) return null;
    const ctx = loadJson(ctxPath);
    const id = (ctx.story || {}).id;
    const tcPath = `${candidateDir}/test-cases/${id}.json`;
    return {
      ctx,
      ctxPath,
      tcDoc: existsSync(tcPath) ? loadJson(tcPath) : null,
      tcPath: existsSync(tcPath) ? tcPath : null,
    };
  }
  const ctxPath = `${EXPECTED_DIR}/${base}.expected-context.json`;
  if (!existsSync(ctxPath)) return null;
  const tcPath = `${EXPECTED_DIR}/${base}.expected-test-cases.json`;
  return {
    ctx: loadJson(ctxPath),
    ctxPath,
    tcDoc: existsSync(tcPath) ? loadJson(tcPath) : null,
    tcPath: existsSync(tcPath) ? tcPath : null,
  };
}

// In candidate mode we evaluate ONE run (the dir's context.json), not one
// per story. In dataset mode we iterate every story's expected outputs.
const stories = candidateDir
  ? ['(candidate run)']
  : readdirSync(STORIES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();

const results = [];
let anyFail = false;

for (const base of stories) {
  const resolved = resolveFor(base);
  if (!resolved) {
    // A story with no expected/candidate context: report it, don't crash.
    results.push({
      story: base,
      scored: false,
      reason: candidateDir
        ? 'no candidate context.json for this story'
        : `no ${base}.expected-context.json`,
      checks: [],
      passed: 0,
      total: 0,
      match_pct: null,
    });
    continue;
  }

  const checks = [...checkContext(resolved.ctx)];
  if (resolved.tcDoc)
    checks.push(...checkTestCases(resolved.tcDoc, resolved.ctx));

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  if (passed !== total) anyFail = true;

  results.push({
    story: base,
    scored: true,
    has_test_cases: Boolean(resolved.tcDoc),
    sources: { context: resolved.ctxPath, test_cases: resolved.tcPath },
    checks,
    failed_checks: checks
      .filter((c) => !c.pass)
      .map((c) => ({ name: c.name, detail: c.detail })),
    passed,
    total,
    match_pct: pct,
  });
}

const scored = results.filter((r) => r.scored);
const overall =
  scored.length > 0
    ? Math.round(
        (scored.reduce((a, r) => a + r.passed, 0) /
          scored.reduce((a, r) => a + r.total, 0)) *
          100
      )
    : 0;

const out = {
  generated_at: new Date().toISOString(),
  mode: candidateDir ? `candidate:${candidateDir}` : 'expected-dataset',
  story_count: stories.length,
  scored_count: scored.length,
  overall_match_pct: overall,
  results,
};

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');

// Console summary.
console.log(`Agent evaluation (${out.mode})`);
console.log(`  Stories: ${stories.length}  |  Scored: ${scored.length}`);
for (const r of results) {
  if (!r.scored) {
    console.log(`  - ${r.story}: SKIPPED (${r.reason})`);
    continue;
  }
  const tag = r.match_pct === 100 ? 'OK ' : 'XX ';
  console.log(
    `  ${tag}${r.story}: ${r.match_pct}% (${r.passed}/${r.total})${r.has_test_cases ? '' : ' [context only]'}`
  );
  for (const f of r.failed_checks) {
    console.log(`        FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
}
console.log(`\nOverall: ${overall}%  ->  wrote ${OUT_FILE}`);

exit(anyFail ? 1 : 0);
