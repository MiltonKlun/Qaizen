#!/usr/bin/env node
// release-report migration for Phase 3 TG12 (enhanced reporting).
//
// TG12 added OPTIONAL fields to schemas/release-report.schema.json:
//   summary_by_risk_level, untested_high_risk_items, flaky_tests,
//   open_bugs_summary, conditional_pass_criteria, external_links.
// Because they are optional, EVERY pre-TG12 release-report.json is still
// valid — no migration is required for validity. This script is therefore a
// safe, idempotent BACKFILL: it derives the deterministically-computable
// fields and adds them if absent, so an old report gains the richer rollups
// without a human re-running the Reporter.
//
// What it backfills (only when missing; never overwrites existing values):
//   - open_bugs_summary      — rolled up from the report's own bug_drafts[].
//   - summary_by_risk_level  — from coverage_by_risk + a sibling context.json's
//                              risks[].severity, IF that context is findable.
//   - untested_high_risk_items — high-severity risks with status 'uncovered',
//                              same source.
// It does NOT invent flaky_tests, conditional_pass_criteria, or external_links
// — those are judgment/observation, not derivable, so they stay for the agent.
//
// Usage:
//   node scripts/migrate-release-report-tg12.js                         # dry-run, release/release-report.json
//   node scripts/migrate-release-report-tg12.js --apply                 # write back
//   node scripts/migrate-release-report-tg12.js <report> [context] [--apply]
//
// Exit codes: 0 ok (or nothing to do) · 1 error · 2 usage/file error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const APPLY = argv.includes('--apply');
const positional = argv.filter((a, i) => i >= 2 && !a.startsWith('--'));
const reportPath = positional[0] || 'release/release-report.json';
const contextPath =
  positional[1] || (existsSync('context.json') ? 'context.json' : null);

if (!existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath}`);
  exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`${reportPath} is not valid JSON: ${e.message}`);
  exit(2);
}

const ctx =
  contextPath && existsSync(contextPath)
    ? JSON.parse(readFileSync(contextPath, 'utf8'))
    : null;

const changes = [];

// 1) open_bugs_summary — from bug_drafts[] (always derivable from the report).
if (
  report.open_bugs_summary === undefined &&
  Array.isArray(report.bug_drafts)
) {
  const b = report.bug_drafts;
  report.open_bugs_summary = {
    total: b.length,
    red: b.filter((x) => x.severity === 'red').length,
    yellow: b.filter((x) => x.severity === 'yellow').length,
    with_jira: b.filter((x) => x.jira_key_if_exists).length,
    without_jira: b.filter((x) => !x.jira_key_if_exists).length,
  };
  changes.push('open_bugs_summary');
}

// 2 & 3) Risk-level rollups — need context.json for severities.
if (ctx && Array.isArray(report.coverage_by_risk) && Array.isArray(ctx.risks)) {
  const sevOf = new Map(ctx.risks.map((r) => [r.risk_id, r.severity]));
  const descOf = new Map(ctx.risks.map((r) => [r.risk_id, r.description]));

  if (report.summary_by_risk_level === undefined) {
    const blank = () => ({
      total: 0,
      covered_passing: 0,
      covered_failing: 0,
      covered_partial: 0,
      accepted_without_test: 0,
      uncovered: 0,
    });
    const roll = { high: blank(), medium: blank(), low: blank() };
    for (const c of report.coverage_by_risk) {
      const sev = sevOf.get(c.risk_id);
      if (!roll[sev]) continue;
      roll[sev].total += 1;
      if (roll[sev][c.status] !== undefined) roll[sev][c.status] += 1;
    }
    report.summary_by_risk_level = roll;
    changes.push('summary_by_risk_level');
  }

  if (report.untested_high_risk_items === undefined) {
    report.untested_high_risk_items = report.coverage_by_risk
      .filter(
        (c) => c.status === 'uncovered' && sevOf.get(c.risk_id) === 'high'
      )
      .map((c) => ({
        risk_id: c.risk_id,
        description: descOf.get(c.risk_id) || '',
      }));
    changes.push('untested_high_risk_items');
  }
} else if (report.summary_by_risk_level === undefined) {
  console.log(
    'No context.json with risks[] found — skipping risk-level rollups ' +
      '(open_bugs_summary still backfilled from the report itself).'
  );
}

if (changes.length === 0) {
  console.log(
    `Nothing to backfill in ${reportPath} (already has the TG12 fields, or ` +
      'nothing derivable). The report is valid either way.'
  );
  exit(0);
}

console.log(`Backfill for ${reportPath}: ${changes.join(', ')}`);

if (!APPLY) {
  console.log('\nDRY RUN (nothing written). Re-run with --apply to save.');
  exit(0);
}

writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\nWrote ${reportPath}. Validate with:`);
console.log(
  `  node scripts/validate-json.js schemas/release-report.schema.json ${reportPath}`
);
exit(0);
