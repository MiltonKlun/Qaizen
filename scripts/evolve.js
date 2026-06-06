#!/usr/bin/env node
// /evolve — self-improvement loop (Phase 3 TG10), adapted from the
// ai-qa-workflow /evolve concept. It READS signals about how the pipeline is
// actually being used and PROPOSES grouped improvements. It never applies a
// change — the human (or an agent, with human confirmation) decides. This is
// the "script gathers + scores deterministically, human judges" pattern, same
// as the classifier and healer harness.
//
// Sources (each optional — a missing source is skipped, never fatal):
//   - Git commits + merges in a recent window (default 90 days).
//   - metrics/pipeline-metrics.json (Phase 3 TG6), if present. Regenerate with
//     `npm run metrics` first to feed evolve fresh numbers.
//   - session-summaries/*.md, if the team wrote any (scripts/session-summary.js).
//   - GitHub issues: NOT fetched here. A plain Node script has no GitHub token
//     wired (the pipeline's GitHub MCP is read-only and agent-only), so issues
//     are an agent-fed source, declared as a gap rather than silently ignored.
//
// Detection (confidence is deterministic, from occurrence counts / thresholds):
//   - Friction points: a theme recurring 3+ times => high confidence (the plan's
//     "3+ occurrences = high-confidence insight").
//   - Workflow gaps: signals that a human repeatedly does something by hand.
//   - Knowledge decay: docs referencing things the code no longer has, or
//     metrics flags (e.g. untested high-risk items, prompt-stability not met).
//   - Usage patterns: where the work actually concentrated.
//
// Output: a grouped, scored proposal at evolve/evolve-proposal.{json,md}
// (gitignored — regenerable). Each finding has { theme, confidence, evidence[],
// proposed_action, targets[] }. The proposal is a SUGGESTION; nothing is edited.
//
// Usage:
//   node scripts/evolve.js                 # 90-day window
//   node scripts/evolve.js --days 30       # custom window
//   node scripts/evolve.js --json          # print JSON to stdout too
//
// Exit codes: 0 ok (proposal written) · 2 read error

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';

const daysIdx = argv.indexOf('--days');
const DAYS = daysIdx !== -1 ? Number(argv[daysIdx + 1]) || 90 : 90;
const ALSO_JSON = argv.includes('--json');
const OUT_DIR = 'evolve';

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// --- Gather sources -------------------------------------------------------

const sources = { git: false, metrics: false, session_summaries: 0 };

// 1) Git commits in window (subjects only — no diffs in the prompt/output).
const since = `--since=${DAYS} days ago`;
const commitLog = git(['log', since, '--pretty=%s']);
const commits = commitLog ? commitLog.split('\n').filter(Boolean) : [];
const nonMerge = commits.filter((s) => !/^Merge (pull request|branch)/.test(s));
sources.git = commits.length > 0;

// 2) Metrics (regenerable; read if the team ran `npm run metrics`).
const metrics = loadJson('metrics/pipeline-metrics.json');
sources.metrics = Boolean(metrics);

// 3) Session summaries (human notes after a run) — the highest-signal source.
// Read the bullet lines so friction themes can be mined, not just counted.
let summaries = [];
let summaryBullets = [];
if (existsSync('session-summaries')) {
  summaries = readdirSync('session-summaries').filter((f) => f.endsWith('.md'));
  for (const f of summaries) {
    const txt = readFileSync(`session-summaries/${f}`, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*-\s+(.*\S)\s*$/);
      if (m) summaryBullets.push(m[1]);
    }
  }
}
sources.session_summaries = summaries.length;

// --- Detect findings ------------------------------------------------------

const findings = [];
const add = (f) => findings.push(f);

// Confidence from occurrence count, per the plan's 3+ rule.
const confFromCount = (n) => (n >= 3 ? 'high' : n === 2 ? 'medium' : 'low');

// Human-reported friction (session summaries) — highest signal. Group bullets
// by a coarse theme keyword so a recurring pain (3+ mentions) reads as high
// confidence, per the plan's 3+ rule.
if (summaryBullets.length > 0) {
  const THEMES = [
    {
      key: 'stacked / orphaned PRs',
      re: /\b(stack|orphan|base branch|auto-?clos)/i,
    },
    {
      key: 'artifact clobber / single-occupancy',
      re: /\b(clobber|overwrit|single-?occupan|rebuild|revert.*content)/i,
    },
    {
      key: 'recovery / rework',
      re: /\b(recover|cherry-?pick|rebuild|redo|rework)/i,
    },
    {
      key: 'CI / merge friction',
      re: /\b(ci|merge conflict|conflict|crlf|lint error)/i,
    },
  ];
  const counts = new Map();
  const evidenceByTheme = new Map();
  for (const b of summaryBullets) {
    for (const t of THEMES) {
      if (t.re.test(b)) {
        counts.set(t.key, (counts.get(t.key) || 0) + 1);
        const arr = evidenceByTheme.get(t.key) || [];
        if (arr.length < 4) arr.push(b);
        evidenceByTheme.set(t.key, arr);
      }
    }
  }
  for (const [theme, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    add({
      theme: `reported-friction: ${theme}`,
      confidence: confFromCount(n),
      evidence: evidenceByTheme.get(theme),
      proposed_action:
        `The team reported "${theme}" ${n} time(s). If 3+, treat as a ` +
        'high-confidence systemic issue: propose a preventive rule or workflow ' +
        'change (e.g. a CLAUDE.md discipline, a guard in a script, a doc). ' +
        'Human confirms before any change.',
      targets: ['CLAUDE.md', 'docs/', 'scripts/'],
    });
  }
}

// Friction theme: count commits that look like fixups / reverts / retries —
// a recurring fix theme is a friction signal worth surfacing.
const frictionRe =
  /\b(fix|hotfix|revert|retry|re-?do|recover|conflict|orphan|clobber|broke|broken|workaround)\b/i;
const frictionCommits = nonMerge.filter((s) => frictionRe.test(s));
if (frictionCommits.length > 0) {
  add({
    theme: 'recurring-fix-friction',
    confidence: confFromCount(frictionCommits.length),
    evidence: frictionCommits.slice(0, 8),
    proposed_action:
      'Review the recurring fix/recover commits for a systemic cause (e.g. a ' +
      'fragile step or a missing guard). If 3+ share a root cause, propose a ' +
      'preventive change to the relevant agent/script/doc.',
    targets: ['CLAUDE.md', 'scripts/', 'docs/'],
  });
}

// Knowledge decay / coverage gaps from metrics.
if (metrics) {
  const untested = metrics.untested_high_risk ?? metrics.untestedHighRisk;
  if (Array.isArray(untested) && untested.length > 0) {
    add({
      theme: 'untested-high-risk-items',
      confidence: confFromCount(untested.length),
      evidence: untested
        .slice(0, 8)
        .map((u) => (typeof u === 'string' ? u : JSON.stringify(u))),
      proposed_action:
        'High-risk items have no covering test. Propose adding cases (Test ' +
        'Designer) or, if intentionally manual, recording the reason. Do not ' +
        'auto-generate — surface for Gate 2.',
      targets: ['test-cases/', 'agents/test-designer.md'],
    });
  }
  const stability =
    metrics.prompt_stability_met ?? metrics.promptStabilityMet ?? null;
  if (stability === false) {
    add({
      theme: 'prompt-stability-not-met',
      confidence: 'medium',
      evidence: ['metrics report: prompt-stability threshold not met'],
      proposed_action:
        'Gate rejection rate is above the <10%/10-run threshold. Review the ' +
        'agent prompt(s) driving the rejected stage; consider a versioned ' +
        'prompt change validated against the evaluation dataset (TG8).',
      targets: ['agents/', 'docs/prompt-versioning.md'],
    });
  }
} else {
  add({
    theme: 'metrics-not-available',
    confidence: 'low',
    evidence: ['metrics/pipeline-metrics.json not found'],
    proposed_action:
      'Run `npm run metrics` so /evolve can read pass-rate, flaky tests, and ' +
      'untested high-risk items. Metrics are regenerable from runs/.',
    targets: ['metrics/'],
  });
}

// Usage pattern: where the work concentrated (by commit-subject prefix).
const areas = {};
for (const s of nonMerge) {
  const m = s.match(/^(\w+)(?:\([^)]*\))?:/); // conventional-commit type
  const key = m ? m[1] : 'other';
  areas[key] = (areas[key] || 0) + 1;
}
const topAreas = Object.entries(areas)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);
if (topAreas.length > 0) {
  add({
    theme: 'usage-pattern',
    confidence: 'low',
    evidence: topAreas.map(([k, n]) => `${k}: ${n} commit(s)`),
    proposed_action:
      'Informational: where effort concentrated in the window. A heavy "fix"/' +
      '"docs" share vs "feat" can hint at churn or knowledge decay worth a ' +
      'closer look.',
    targets: [],
  });
}

// Source gaps the team should close to make /evolve sharper next time.
const gaps = [];
if (sources.session_summaries === 0)
  gaps.push(
    'No session-summaries/ — run `npm run session-summary` after a run to ' +
      'capture friction in the human’s words (the highest-signal source).'
  );
gaps.push(
  'GitHub issues are not fetched by this script (no token in a plain Node ' +
    'context). Feed issue themes via the agent path if the repo uses issues.'
);
if (gaps.length > 0) {
  add({
    theme: 'evolve-input-gaps',
    confidence: 'low',
    evidence: gaps,
    proposed_action:
      'Close the input gaps so the next /evolve run has higher-signal data.',
    targets: ['session-summaries/', 'docs/evolve-loop.md'],
  });
}

// --- Emit -----------------------------------------------------------------

const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => order[a.confidence] - order[b.confidence]);

const proposal = {
  generated_at: new Date().toISOString(),
  window_days: DAYS,
  sources,
  commit_count: commits.length,
  non_merge_commit_count: nonMerge.length,
  finding_count: findings.length,
  findings,
  disclaimer:
    'Suggestions only. /evolve never edits prompts, schemas, docs, or code. ' +
    'A human reviews and confirms each action before it is applied (CLAUDE.md ' +
    'Phase 3 §2: metrics guide improvement, they do not rewrite contracts).',
};

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  `${OUT_DIR}/evolve-proposal.json`,
  JSON.stringify(proposal, null, 2) + '\n'
);

const md = [];
md.push('# /evolve proposal');
md.push('');
md.push(`_Generated ${proposal.generated_at} · window ${DAYS} days_`);
md.push('');
md.push(
  `Sources: git=${sources.git ? 'yes' : 'no'}, metrics=${sources.metrics ? 'yes' : 'no'}, ` +
    `session-summaries=${sources.session_summaries}. Commits in window: ` +
    `${commits.length} (${nonMerge.length} non-merge).`
);
md.push('');
md.push('> ' + proposal.disclaimer);
md.push('');
for (const f of findings) {
  const badge =
    f.confidence === 'high' ? '🔴' : f.confidence === 'medium' ? '🟡' : '⚪';
  md.push(`## ${badge} ${f.theme} (${f.confidence} confidence)`);
  md.push('');
  md.push('**Evidence:**');
  for (const e of f.evidence) md.push(`- ${e}`);
  md.push('');
  md.push(`**Proposed action:** ${f.proposed_action}`);
  if (f.targets.length) md.push(`**Targets:** ${f.targets.join(', ')}`);
  md.push('');
}
writeFileSync(`${OUT_DIR}/evolve-proposal.md`, md.join('\n') + '\n');

console.log(`/evolve — ${findings.length} finding(s), window ${DAYS} days.`);
for (const f of findings) {
  console.log(`  [${f.confidence}] ${f.theme}`);
}
console.log(`\nWrote ${OUT_DIR}/evolve-proposal.{json,md} (suggestions only).`);

if (ALSO_JSON) console.log('\n' + JSON.stringify(proposal, null, 2));
exit(0);
