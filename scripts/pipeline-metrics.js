#!/usr/bin/env node
// @ts-check
// Pipeline metrics (Phase 3 TG6). Walks the archived runs under runs/ (the
// TG5 history) and computes aggregate metrics so the team can tell whether the
// pipeline is improving QA or creating noise. Outputs metrics/pipeline-metrics.
// {md,json}. Recommended cadence: after every ~5 completed runs.
//
// It reads whatever each archived run contains — context.json, test-cases,
// analysis/failure-analysis.json, release/release-report.json,
// analysis/healer-validation/ — and skips gracefully when an artifact is
// absent (partial archives are fine; they just contribute what they have).
//
// Metrics guide improvement; they NEVER rewrite prompts or contracts
// automatically (Phase 3 non-negotiable rule).
//
// Usage:
//   node scripts/pipeline-metrics.js                 # write metrics/pipeline-metrics.{md,json}
//   node scripts/pipeline-metrics.js --dry-run       # print, do not write
//
// Exit codes: 0 ok · 2 no runs/ dir

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateValue } from './lib/artifact-io.js';
import { failureMetrics, healerMetrics } from './lib/run-metrics.js';
import {
  GATE3_KEYS,
  GATE4_KEYS,
  promptStability,
  renderPromptStability,
} from './lib/prompt-stability.js';

const DRY = argv.includes('--dry-run');
const RUNS = 'runs';
const OUT_DIR = 'metrics';
const HEALER_RECORD_SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'healer-validation.schema.json'
);

if (!existsSync(RUNS)) {
  console.error(
    `No ${RUNS}/ directory. Archive runs with scripts/new-run.js first.`
  );
  exit(2);
}

/** @type {(p: string) => any} parsed JSON, or null when unreadable */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// Discover archived runs: runs/<story>/<run-id>/.
const runs = [];
// Demo runs are kept apart: they count toward nothing, but the prompt-stability
// result lists them as excluded so the sample is accounted for (task group 8.2).
const demoRuns = [];
for (const story of readdirSync(RUNS).sort()) {
  if (story === 'latest.json') continue;
  const storyDir = join(RUNS, story);
  let entries;
  try {
    entries = readdirSync(storyDir).sort();
  } catch {
    continue;
  }
  for (const dirName of entries) {
    const base = join(storyDir, dirName);
    if (
      !existsSync(join(base, 'run-manifest.json')) &&
      !existsSync(join(base, 'context.json'))
    )
      continue;
    // Skip demo runs (scripts/demo-pipeline.js). A DEMO_RUN sentinel file in
    // the run folder marks a replayed demo — it must never count toward
    // pass rate, gate-cost, or the prompt_stability threshold (IP-3.3).
    if (existsSync(join(base, 'DEMO_RUN'))) {
      demoRuns.push({ story, runId: dirName, base });
      continue;
    }
    runs.push({ story, dir: dirName, base });
  }
}

// ---- accumulate metrics --------------------------------------------------
// A run is identified by its story and the run id it records; the same run
// archived twice is one run (task group 8.3). A run that records no id falls
// back to its archive folder name.
const seen = new Set();
let duplicateArchives = 0;
const samples = {
  runs: 0,
  with_release_report: 0,
  with_failure_analysis: 0,
  with_risk_coverage: 0,
  with_healer_evidence: 0,
};
/** @type {Record<string, number[]>} */
const passRateByStory = {}; // story -> [pass_rate,...]
/** @type {Parameters<typeof failureMetrics>[0]} */
const analyses = []; // {story, runId, failures}
/** @type {Parameters<typeof healerMetrics>[0]} */
const healerDirs = []; // {story, runId, files}
let productBugsFound = 0;
// Gate rejections per run come from context.gate_decisions[] (the optional
// append-only log). A run with no gate_decisions contributes nothing (older
// runs) — we track how many runs actually carry the log so the metric is
// honest about its sample.
let gate3Rejections = 0;
let gate4Rejections = 0;
let runsWithGateLog = 0;
// How many runs carry a non-empty prompt_versions map (T4.2).
let runsWithPromptVersions = 0;
/** @type {{ story: string, run_id: string, risk_id: string }[]} */
const untestedHighRisk = []; // {story, run_id, risk_id}
// What the prompt-stability computation reads per run (demo runs included, as
// exclusions).
/** @type {import('./lib/prompt-stability.js').ArchivedRun[]} */
const stabilityRuns = demoRuns.map((r) => ({
  story: r.story,
  runId: r.runId,
  demo: true,
  context: null,
}));

for (const run of runs) {
  const ctx = readJson(join(run.base, 'context.json'));
  const report = readJson(join(run.base, 'release', 'release-report.json'));
  const fa = readJson(join(run.base, 'analysis', 'failure-analysis.json'));
  const runId = ctx?.run_id || fa?.run_id || run.dir;
  const identity = `${run.story}|${runId}`;
  if (seen.has(identity)) {
    duplicateArchives += 1;
    continue;
  }
  seen.add(identity);
  samples.runs += 1;
  stabilityRuns.push({
    story: run.story,
    runId,
    context: ctx,
    failureAnalysis: fa,
  });

  // pass rate (from release report execution_summary; flat or grouped)
  if (report) samples.with_release_report += 1;
  if (report?.execution_summary) {
    const es = report.execution_summary;
    const rate =
      typeof es.pass_rate === 'number' ? es.pass_rate : es.combined?.pass_rate;
    if (typeof rate === 'number') {
      (passRateByStory[run.story] ||= []).push(rate);
    }
  }

  // failing test cases + flaky units + product bugs (from failure-analysis)
  if (fa) {
    samples.with_failure_analysis += 1;
    analyses.push({ story: run.story, runId, failures: fa.failures ?? [] });
    productBugsFound += (fa.failures ?? []).filter(
      (/** @type {Record<string, any>} */ f) =>
        f.classification === 'product_bug'
    ).length;
  }

  // untested high-risk (from release report coverage_by_risk + context severities)
  if (report?.coverage_by_risk && ctx?.risks) {
    samples.with_risk_coverage += 1;
    const sevById = Object.fromEntries(
      ctx.risks.map((/** @type {Record<string, any>} */ r) => [
        r.risk_id,
        r.severity,
      ])
    );
    for (const c of report.coverage_by_risk) {
      if (c.status === 'uncovered' && sevById[c.risk_id] === 'high') {
        untestedHighRisk.push({
          story: run.story,
          run_id: runId,
          risk_id: c.risk_id,
        });
      }
    }
  }

  // healer evidence (analysis/healer-validation/), judged in lib/run-metrics.js
  const hv = join(run.base, 'analysis', 'healer-validation');
  if (existsSync(hv)) {
    const files = readdirSync(hv)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(hv, name), 'utf8') }));
    if (files.length) samples.with_healer_evidence += 1;
    healerDirs.push({ story: run.story, runId, files });
  }

  // gate rejection counts from the optional gate_decisions[] log.
  if (Array.isArray(ctx?.gate_decisions)) {
    runsWithGateLog += 1;
    for (const d of ctx.gate_decisions) {
      if (d.decision !== 'rejected') continue;
      // Gate 3 and Gate 4 of every branch: E2E, the API's 3' and 4', and the
      // external plan and evidence reviews (task group 7.2).
      if (GATE3_KEYS.has(d.gate)) gate3Rejections += 1;
      if (GATE4_KEYS.has(d.gate)) gate4Rejections += 1;
    }
  }

  // prompt-version linkage: a non-empty prompt_versions map (Analyst v1.3.0+).
  if (
    ctx?.prompt_versions &&
    typeof ctx.prompt_versions === 'object' &&
    Object.keys(ctx.prompt_versions).length > 0
  ) {
    runsWithPromptVersions += 1;
  }
}

const totalRuns = samples.runs;
const avg = (/** @type {number[]} */ arr) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const passRateSummary = Object.fromEntries(
  Object.entries(passRateByStory).map(([s, rates]) => [
    s,
    { average_pass_rate: avg(rates), runs_with_rate: rates.length },
  ])
);
const failureStats = failureMetrics(analyses);
const healer = healerMetrics(
  healerDirs,
  (rec) => validateValue(rec, HEALER_RECORD_SCHEMA).ok
);

/** @type {Record<string, any>} the metrics JSON, extended below */
const metrics = {
  generated_at: new Date().toISOString(),
  total_runs: totalRuns,
  duplicate_run_archives: duplicateArchives,
  // How many runs each metric could actually read. A metric over zero
  // samples is unknown, not zero (task group 8.3).
  samples,
  pass_rate_by_story: passRateSummary,
  ...failureStats,
  product_bugs_found_by_generated_tests: {
    count: productBugsFound,
    runs_with_failure_analysis: samples.with_failure_analysis,
  },
  healer_patch_validation: healer,
  gate_rejections: {
    runs_with_gate_log: runsWithGateLog,
    total_runs: totalRuns,
    gate3_specs_rejections: gate3Rejections,
    gate4_code_rejections: gate4Rejections,
    note:
      runsWithGateLog === 0
        ? 'No run carries a gate_decisions log yet — counts are 0 because none is recorded, not because none happened. Record gate decisions to make this meaningful.'
        : `Counted over ${runsWithGateLog}/${totalRuns} run(s) that carry a gate_decisions log.`,
  },
  untested_high_risk_items: untestedHighRisk,
};

// Prompt stability (Phase 3 §6, rebuilt in task group 8.2): one result, per
// prompt-version cohort, that the JSON, the Markdown and /evolve all read.
metrics.prompt_stability = promptStability(stabilityRuns);
metrics.runs_with_prompt_versions = runsWithPromptVersions;

// ---- markdown ------------------------------------------------------------
const pct = (/** @type {number | null} */ r) =>
  r === null ? 'n/a' : `${Math.round(r * 100)}%`;
const of = (/** @type {number} */ n) => `${n}/${totalRuns} run(s)`;
/** @type {(sampleCount: number, what: string) => string} */
const unknownOrNone = (sampleCount, what) =>
  sampleCount === 0
    ? `- Unknown: no run has ${what}, so absence here proves nothing.`
    : '- (none)';
const md = [
  '# Pipeline Metrics',
  '',
  `Generated: ${metrics.generated_at}`,
  `Runs analyzed (from runs/): **${totalRuns}**` +
    (duplicateArchives
      ? ` (${duplicateArchives} duplicate archive(s) of the same run ignored)`
      : ''),
  '',
  '## Pass rate by story',
  '',
  `- Sample: ${of(samples.with_release_report)} with a release report.`,
  ...(Object.keys(passRateSummary).length
    ? Object.entries(passRateSummary).map(
        ([s, r]) =>
          `- ${s}: ${pct(r.average_pass_rate)} (average of ${r.runs_with_rate} run(s))`
      )
    : [unknownOrNone(samples.with_release_report, 'a release report')]),
  '',
  '## Top failing test cases',
  '',
  `- Sample: ${of(samples.with_failure_analysis)} with a failure analysis; ${failureStats.failures_without_test_case} failure(s) not linked to a test case.`,
  ...(failureStats.top_failing_test_cases.length
    ? failureStats.top_failing_test_cases.map(
        (t) =>
          `- ${t.story} ${t.test_case_id}: ${t.failures} failure(s) in ${t.runs.join(', ')}`
      )
    : [unknownOrNone(samples.with_failure_analysis, 'a failure analysis')]),
  '',
  '## Flakiest tests',
  '',
  `- Sample: ${of(samples.with_failure_analysis)} with a failure analysis; ${failureStats.flaky_without_identity} flaky failure(s) with no provable unit identity.`,
  ...(failureStats.flakiest_tests.length
    ? failureStats.flakiest_tests.map(
        (t) =>
          `- ${t.story} ${t.source} ${t.unit}${t.project ? ` [${t.project}]` : ''}: ${t.flaky_count} in ${t.runs.join(', ')}`
      )
    : [unknownOrNone(samples.with_failure_analysis, 'a failure analysis')]),
  '',
  '## Healer patch validation',
  '',
  `- Structured submissions: ${healer.submissions} · validated: ${healer.validated} · validation failed: ${healer.validation_failed} · rejected by the static check: ${healer.rejected_static}`,
  `- Success rate (validated / submissions): ${pct(healer.success_rate)}` +
    (healer.success_rate === null ? ' — no structured submission yet' : ''),
  `- Not counted as patches: ${healer.yellow_suggestions} Yellow suggestion(s), ${healer.exhausted_notices} exhausted notice(s), ${healer.invalid_records} invalid record(s), ${healer.duplicate_records} duplicate record(s)`,
  `- Legacy Markdown notes (unverified, never counted): ${healer.legacy_markdown_notes}`,
  '',
  '## Product bugs found by generated tests',
  '',
  samples.with_failure_analysis
    ? `- ${productBugsFound} (over ${of(samples.with_failure_analysis)} with a failure analysis)`
    : unknownOrNone(0, 'a failure analysis'),
  '',
  '## Untested high-risk items',
  '',
  `- Sample: ${of(samples.with_risk_coverage)} with risk coverage in their report.`,
  ...(untestedHighRisk.length
    ? untestedHighRisk.map((u) => `- ${u.story} (${u.run_id}): ${u.risk_id}`)
    : [unknownOrNone(samples.with_risk_coverage, 'risk coverage')]),
  '',
  '## Gate rejections',
  '',
  `- Gate 3 (specs) rejections: ${gate3Rejections} · Gate 4 (code) rejections: ${gate4Rejections}`,
  `- Counted over ${runsWithGateLog}/${totalRuns} run(s) carrying a gate_decisions log.`,
  ...(runsWithGateLog === 0
    ? [
        '- No run records gate_decisions yet — record them (a rejection event when a gate is sent back) to make this real. 0 here means "unrecorded", not "never happened".',
      ]
    : []),
  '',
  '## Prompt stability',
  '',
  ...renderPromptStability(metrics.prompt_stability),
  `- Runs carrying prompt_versions: ${runsWithPromptVersions}/${totalRuns}.`,
  '',
  '> Metrics guide improvement; they never rewrite prompts or contracts',
  '> automatically. See docs/pipeline-architecture.md "Metrics and Monitoring".',
  '',
].join('\n');

console.log(md);

if (DRY) {
  console.log('\nDRY RUN (not written).');
  exit(0);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'pipeline-metrics.json'),
  JSON.stringify(metrics, null, 2) + '\n'
);
writeFileSync(join(OUT_DIR, 'pipeline-metrics.md'), md);
console.log(
  `\nWrote ${OUT_DIR}/pipeline-metrics.{json,md} from ${totalRuns} run(s).`
);
exit(0);
