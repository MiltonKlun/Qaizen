#!/usr/bin/env node
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
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const DRY = argv.includes('--dry-run');
const RUNS = 'runs';
const OUT_DIR = 'metrics';

if (!existsSync(RUNS)) {
  console.error(
    `No ${RUNS}/ directory. Archive runs with scripts/new-run.js first.`
  );
  exit(2);
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// Discover archived runs: runs/<story>/<run-id>/.
const runs = [];
for (const story of readdirSync(RUNS)) {
  if (story === 'latest.json') continue;
  const storyDir = join(RUNS, story);
  let entries;
  try {
    entries = readdirSync(storyDir);
  } catch {
    continue;
  }
  for (const runId of entries) {
    const base = join(storyDir, runId);
    if (
      !existsSync(join(base, 'run-manifest.json')) &&
      !existsSync(join(base, 'context.json'))
    )
      continue;
    runs.push({ story, runId, base });
  }
}

// ---- accumulate metrics --------------------------------------------------
let totalRuns = runs.length;
const passRateByStory = {}; // story -> [pass_rate,...]
const tcFailCounts = {}; // TC id -> times it appears in a failure
const flakyCounts = {}; // PW/REQ id -> flaky count (from failure classification)
let productBugsFound = 0;
let healerTotal = 0;
let healerValidated = 0;
let gate3Rejections = 0; // not tracked per-run today; reported as n/a
let gate4Rejections = 0;
const untestedHighRisk = []; // {story, risk_id}

for (const run of runs) {
  const ctx = readJson(join(run.base, 'context.json'));
  const report = readJson(join(run.base, 'release', 'release-report.json'));
  const fa = readJson(join(run.base, 'analysis', 'failure-analysis.json'));

  // pass rate (from release report execution_summary; flat or grouped)
  if (report?.execution_summary) {
    const es = report.execution_summary;
    const rate =
      typeof es.pass_rate === 'number' ? es.pass_rate : es.combined?.pass_rate;
    if (typeof rate === 'number') {
      (passRateByStory[run.story] ||= []).push(rate);
    }
  }

  // failing TCs + flaky + product bugs (from failure-analysis)
  for (const f of fa?.failures || []) {
    if (f.test_case_id)
      tcFailCounts[f.test_case_id] = (tcFailCounts[f.test_case_id] || 0) + 1;
    if (f.classification === 'flaky') {
      const id = f.playwright_test_id || f.request_id || f.failure_id;
      flakyCounts[id] = (flakyCounts[id] || 0) + 1;
    }
    if (f.classification === 'product_bug') productBugsFound += 1;
  }

  // untested high-risk (from release report coverage_by_risk + context severities)
  if (report?.coverage_by_risk && ctx?.risks) {
    const sevById = Object.fromEntries(
      ctx.risks.map((r) => [r.risk_id, r.severity])
    );
    for (const c of report.coverage_by_risk) {
      if (c.status === 'uncovered' && sevById[c.risk_id] === 'high') {
        untestedHighRisk.push({ story: run.story, risk_id: c.risk_id });
      }
    }
  }
  // Phase 2.6 explicit field, if present
  if (
    typeof report?.uncovered_high_severity_count === 'number' &&
    report.uncovered_high_severity_count > 0
  ) {
    // already captured per-risk above when coverage_by_risk present
  }

  // healer validation success rate (from analysis/healer-validation/)
  const hv = join(run.base, 'analysis', 'healer-validation');
  if (existsSync(hv)) {
    for (const file of readdirSync(hv)) {
      if (!file.endsWith('.md')) continue;
      healerTotal += 1;
      const body = readFileSync(join(hv, file), 'utf8');
      if (!/REJECTED/i.test(body)) healerValidated += 1;
    }
  }

  // gate rejection counts: not recorded per-run in the current schema; the
  // audit-field notes could carry them in future. Report as not-tracked.
}

const avg = (arr) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const passRateSummary = Object.fromEntries(
  Object.entries(passRateByStory).map(([s, rates]) => [s, avg(rates)])
);
const topFailingTcs = Object.entries(tcFailCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([id, n]) => ({ test_case_id: id, failures: n }));
const topFlaky = Object.entries(flakyCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([id, n]) => ({ id, flaky_count: n }));

const metrics = {
  generated_at: new Date().toISOString(),
  total_runs: totalRuns,
  average_pass_rate_by_story: passRateSummary,
  top_failing_test_cases: topFailingTcs,
  flakiest_tests: topFlaky,
  product_bugs_found_by_generated_tests: productBugsFound,
  healer_patch_validation: {
    total: healerTotal,
    validated: healerValidated,
    success_rate: healerTotal ? healerValidated / healerTotal : null,
  },
  gate3_rejections: gate3Rejections || 'not_tracked_per_run',
  gate4_rejections: gate4Rejections || 'not_tracked_per_run',
  untested_high_risk_items: untestedHighRisk,
};

// ---- markdown ------------------------------------------------------------
const pct = (r) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
const md = [
  '# Pipeline Metrics',
  '',
  `Generated: ${metrics.generated_at}`,
  `Runs analyzed (from runs/): **${totalRuns}**`,
  '',
  '## Average pass rate by story',
  '',
  Object.keys(passRateSummary).length
    ? Object.entries(passRateSummary)
        .map(([s, r]) => `- ${s}: ${pct(r)}`)
        .join('\n')
    : '- (no release reports in archived runs yet)',
  '',
  '## Top failing test cases',
  '',
  topFailingTcs.length
    ? topFailingTcs
        .map((t) => `- ${t.test_case_id}: ${t.failures} failure(s)`)
        .join('\n')
    : '- (none)',
  '',
  '## Flakiest tests',
  '',
  topFlaky.length
    ? topFlaky.map((t) => `- ${t.id}: ${t.flaky_count}`).join('\n')
    : '- (none)',
  '',
  '## Healer patch validation',
  '',
  `- Patches: ${healerTotal} · validated: ${healerValidated} · success rate: ${pct(metrics.healer_patch_validation.success_rate)}`,
  '',
  '## Product bugs found by generated tests',
  '',
  `- ${productBugsFound}`,
  '',
  '## Untested high-risk items',
  '',
  untestedHighRisk.length
    ? untestedHighRisk.map((u) => `- ${u.story}: ${u.risk_id}`).join('\n')
    : '- (none)',
  '',
  '## Gate rejections',
  '',
  '- Gate 3 / Gate 4 rejection counts are not recorded per-run in the current',
  '  schema (the TG6 wish-list item). When gate audit-field notes start carrying',
  '  rejection history, surface them here. For now: not tracked.',
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
