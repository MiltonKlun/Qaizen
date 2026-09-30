// Prompt stability: eligible runs, per-cohort verdicts, and one result that
// the JSON, the Markdown and /evolve all read (task group 8.2, finding B7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import {
  exclusionReason,
  promptStability,
  renderPromptStability,
} from '../scripts/lib/prompt-stability.js';
import { failureMetrics, healerMetrics } from '../scripts/lib/run-metrics.js';

const REPO = process.cwd();
const V1 = {
  analyst: '2.0.1',
  'test-designer': '1.5.0',
  'failure-classifier': '2.3.0',
  reporter: '3.3.0',
};
const V2 = { ...V1, 'test-designer': '1.6.0' };

const decision = (gate, verdict = 'approved', day = 1) => ({
  gate,
  decision: verdict,
  opened_at: `2026-09-${String(day).padStart(2, '0')}T09:00:00Z`,
  decided_at: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
  reviewer: 'h',
  notes: verdict === 'rejected' ? 'fix it' : null,
});

/** A completed, reviewed run on day `day` (1..28). */
function run(i, { versions = V1, rejections = [], day = i, ...over } = {}) {
  return {
    story: `STORY-${String(i).padStart(3, '0')}`,
    runId: `run-${String(i).padStart(2, '0')}`,
    context: {
      status: 'completed',
      prompt_versions: versions,
      gate_decisions: [
        decision('requirements_reviewed', 'approved', day),
        ...rejections.map((g) => decision(g, 'rejected', day)),
        decision('specs_reviewed', 'approved', day),
        decision('code_reviewed', 'approved', day),
      ],
      ...over.context,
    },
    failureAnalysis: {
      execution_date: `2026-09-${String(day).padStart(2, '0')}T11:00:00Z`,
    },
    ...(over.demo ? { demo: true } : {}),
  };
}
const runs = (n, opts = () => ({})) =>
  Array.from({ length: n }, (_, k) => run(k + 1, opts(k + 1)));
const only = (ps) => {
  assert.equal(ps.cohorts.length, 1);
  return ps.cohorts[0];
};

// ------------------------------------------------------------ sample size

test('zero eligible runs: no cohort, no verdict', () => {
  const ps = promptStability([]);
  assert.deepEqual(ps.cohorts, []);
  assert.deepEqual(ps.qualifying_cohorts, []);
  assert.equal(ps.overall_verdict, null);
  assert.match(
    renderPromptStability(ps).join('\n'),
    /NOT COMPUTABLE — no eligible run/
  );
});

test('nine eligible runs are not computable; ten clean runs are met', () => {
  let c = only(promptStability(runs(9)));
  assert.equal(c.verdict, 'not_computable');
  assert.equal(c.reason, '9/10 eligible runs for this prompt-version vector');

  const ps = promptStability(runs(10));
  c = only(ps);
  assert.equal(c.verdict, 'met');
  assert.equal(c.sample_size, 10);
  assert.equal(c.rejection_rate, 0);
  assert.deepEqual(ps.qualifying_cohorts, [
    { cohort: c.cohort, verdict: 'met' },
  ]);
  assert.equal(ps.overall_verdict, null, 'never one verdict across cohorts');
});

// ------------------------------------------------------------ the rate

test('one rejected run in ten is not met: the threshold is strictly below 10%', () => {
  const c = only(
    promptStability(
      runs(10, (i) => (i === 4 ? { rejections: ['code_reviewed'] } : {}))
    )
  );
  assert.equal(c.affected_runs, 1);
  assert.equal(c.rejection_rate, 0.1);
  assert.equal(c.verdict, 'not_met');
});

test('ten rejected runs never render as met', () => {
  const ps = promptStability(
    runs(10, () => ({ rejections: ['specs_reviewed'] }))
  );
  const c = only(ps);
  assert.equal(c.verdict, 'not_met');
  assert.equal(c.rejection_rate, 1);
  const md = renderPromptStability(ps).join('\n');
  assert.match(md, /: NOT MET — 10\/10 sampled run\(s\)/);
  assert.doesNotMatch(md, /: MET\b/);
});

test('several rejections in one run count as one affected run; events are kept', () => {
  const c = only(
    promptStability(
      runs(10, (i) =>
        i === 2
          ? { rejections: ['specs_reviewed', 'code_reviewed', 'code_reviewed'] }
          : {}
      )
    )
  );
  assert.equal(c.affected_runs, 1);
  assert.equal(c.rejection_events, 3);
});

test('API and external final reviews count as Gate 3/4 equivalents; Gate 1/2 rejections do not', () => {
  for (const gate of [
    'collection_reviewed',
    'api_assertions_reviewed',
    'external_plan_reviewed',
    'external_evidence_reviewed',
  ]) {
    const versions = gate.startsWith('external')
      ? V1
      : { ...V1, 'api-agent': '1.3.0' };
    const c = only(
      promptStability(
        runs(10, (i) => ({
          versions,
          ...(i === 1 ? { rejections: [gate] } : {}),
        }))
      )
    );
    assert.equal(c.affected_runs, 1, gate);
  }
  const c = only(
    promptStability(
      runs(10, (i) => (i === 1 ? { rejections: ['test_scope_reviewed'] } : {}))
    )
  );
  assert.equal(c.affected_runs, 0);
  assert.equal(c.verdict, 'met');
});

// ------------------------------------------------------------ eligibility

test('missing provenance excludes the run, with a reason', () => {
  const base = run(1);
  const cases = [
    [{ ...base, demo: true }, 'demo run'],
    [{ ...base, context: null }, 'no readable context.json'],
    [
      { ...base, context: { ...base.context, status: 'in_progress' } },
      'not a completed run',
    ],
    [
      { ...base, context: { ...base.context, gate_decisions: [] } },
      'no Gate 3/4 decision record',
    ],
    [
      {
        ...base,
        context: {
          ...base.context,
          gate_decisions: [decision('requirements_reviewed')],
        },
      },
      'no Gate 3/4 decision record',
    ],
    [
      { ...base, context: { ...base.context, prompt_versions: undefined } },
      'no prompt version for analyst, test-designer, failure-classifier, reporter',
    ],
    [
      {
        ...base,
        context: {
          ...base.context,
          prompt_versions: { ...V1, reporter: undefined },
        },
      },
      'no prompt version for reporter',
    ],
    [
      {
        ...base,
        context: {
          ...base.context,
          gate_decisions: [
            ...base.context.gate_decisions,
            decision('api_assertions_reviewed'),
          ],
        },
      },
      'no prompt version for api-agent',
    ],
    [
      {
        ...base,
        failureAnalysis: null,
        context: {
          ...base.context,
          gate_decisions: [{ gate: 'code_reviewed', decision: 'approved' }],
        },
      },
      'no execution timestamp',
    ],
  ];
  for (const [r, reason] of cases) assert.equal(exclusionReason(r), reason);

  const ps = promptStability([
    ...runs(10),
    { ...run(11), demo: true },
    { ...run(12), context: { ...run(12).context, prompt_versions: undefined } },
  ]);
  assert.equal(ps.eligible_runs, 10);
  assert.deepEqual(ps.excluded_by_reason, {
    'demo run': 1,
    'no prompt version for analyst, test-designer, failure-classifier, reporter': 1,
  });
  assert.equal(only(ps).verdict, 'met');
});

test('mixed prompt versions are separate cohorts, never pooled into one verdict', () => {
  const ps = promptStability([
    ...runs(10),
    ...Array.from({ length: 5 }, (_, k) =>
      run(20 + k, { versions: V2, rejections: ['code_reviewed'] })
    ),
  ]);
  assert.equal(ps.cohorts.length, 2);
  const [a, b] = ps.cohorts;
  const byVersion = (v) =>
    ps.cohorts.find((c) => c.prompt_versions['test-designer'] === v);
  assert.equal(byVersion('1.5.0').verdict, 'met');
  assert.equal(byVersion('1.6.0').verdict, 'not_computable');
  assert.equal(byVersion('1.6.0').affected_runs, 5);
  assert.ok(a.cohort !== b.cohort);
  assert.equal(ps.qualifying_cohorts.length, 1);
});

test('the sample is the latest ten runs by execution time, run id breaking ties', () => {
  // Two older rejected runs fall outside the latest ten.
  const older = [
    run(1, { rejections: ['code_reviewed'] }),
    run(2, { rejections: ['code_reviewed'] }),
  ];
  const newer = runs(10).map((r, k) => ({ ...run(k + 3) }));
  let c = only(promptStability([...older, ...newer]));
  assert.equal(c.verdict, 'met');
  assert.equal(c.eligible_runs, 12);
  assert.ok(
    !c.sample.some((s) => s.endsWith('run-01') || s.endsWith('run-02'))
  );

  // Same execution day for all: the higher run ids are the latest.
  const same = Array.from({ length: 11 }, (_, k) =>
    run(k + 1, {
      day: 5,
      ...(k === 0 ? { rejections: ['code_reviewed'] } : {}),
    })
  );
  c = only(promptStability(same));
  assert.equal(
    c.verdict,
    'met',
    'run-01 (the rejected one) is the oldest by tie-break'
  );
});

// ------------------------------------------------------------ the CLI

function workspace(runList) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-metrics-'));
  mkdirSync(join(dir, 'runs'));
  for (const r of runList) {
    const base = join(dir, 'runs', r.story, r.runId);
    mkdirSync(join(base, 'analysis'), { recursive: true });
    if (r.context)
      writeFileSync(join(base, 'context.json'), JSON.stringify(r.context));
    else writeFileSync(join(base, 'run-manifest.json'), '{}');
    writeFileSync(
      join(base, 'analysis', 'failure-analysis.json'),
      JSON.stringify(r.failureAnalysis ?? {})
    );
    if (r.demo) writeFileSync(join(base, 'DEMO_RUN'), '');
  }
  return dir;
}
const node = (dir, script, args = []) =>
  spawnSync(execPath, [join(REPO, 'scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });

test('JSON and Markdown agree on every fixture', () => {
  const fixtures = {
    none: [],
    nine: runs(9),
    met: runs(10),
    oneRejected: runs(10, (i) =>
      i === 3 ? { rejections: ['code_reviewed'] } : {}
    ),
    allRejected: runs(10, () => ({ rejections: ['specs_reviewed'] })),
    mixed: [
      ...runs(10),
      ...Array.from({ length: 3 }, (_, k) => run(30 + k, { versions: V2 })),
    ],
    demo: [...runs(9), { ...run(15), demo: true }],
  };
  for (const [name, list] of Object.entries(fixtures)) {
    const dir = workspace(list);
    try {
      const r = node(dir, 'pipeline-metrics.js');
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      const json = JSON.parse(
        readFileSync(join(dir, 'metrics', 'pipeline-metrics.json'), 'utf8')
      );
      const md = readFileSync(
        join(dir, 'metrics', 'pipeline-metrics.md'),
        'utf8'
      );
      const ps = json.prompt_stability;
      assert.equal('prompt_stability_met' in json, false, name);
      for (const line of renderPromptStability(ps)) {
        assert.ok(md.includes(line), `${name}: Markdown lacks "${line}"`);
      }
      const verdicts = ps.cohorts.map((c) => c.verdict);
      const mdMet = (md.match(/: MET —/g) ?? []).length;
      assert.equal(mdMet, verdicts.filter((v) => v === 'met').length, name);
      assert.equal(
        (md.match(/: NOT MET —/g) ?? []).length,
        verdicts.filter((v) => v === 'not_met').length,
        name
      );
      if (name === 'demo') assert.equal(ps.excluded_by_reason['demo run'], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('/evolve reports a failing cohort, and too little evidence as exactly that', () => {
  for (const [list, theme, absent] of [
    [
      runs(10, () => ({ rejections: ['code_reviewed'] })),
      'prompt-stability-not-met',
      'prompt-stability-insufficient-evidence',
    ],
    [
      runs(4),
      'prompt-stability-insufficient-evidence',
      'prompt-stability-not-met',
    ],
  ]) {
    const dir = workspace(list);
    try {
      assert.equal(node(dir, 'pipeline-metrics.js').status, 0);
      const r = node(dir, 'evolve.js', ['--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`"theme": "${theme}"`));
      assert.doesNotMatch(r.stdout, new RegExp(`"theme": "${absent}"`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Task group 8.3: metric identities and healer denominators.

const pwFailure = (
  tc,
  { title = 'logs in', project = 'chromium', ...over } = {}
) => ({
  failure_id: 'FAIL-001',
  test_case_id: tc,
  source: 'playwright',
  classification: 'flaky',
  runner_identity: {
    kind: 'playwright',
    file: 'tests/a.spec.ts',
    test_title: title,
    project,
  },
  ...over,
});

test('two stories sharing a TC id stay two rows, each naming its runs', () => {
  const m = failureMetrics([
    { story: 'STORY-001', runId: 'r1', failures: [pwFailure('TC-001')] },
    { story: 'STORY-002', runId: 'r2', failures: [pwFailure('TC-001')] },
    { story: 'STORY-001', runId: 'r3', failures: [pwFailure('TC-001')] },
  ]);
  assert.deepEqual(
    m.top_failing_test_cases.map((r) => [
      r.story,
      r.test_case_id,
      r.failures,
      r.runs,
    ]),
    [
      ['STORY-001', 'TC-001', 2, ['r1', 'r3']],
      ['STORY-002', 'TC-001', 1, ['r2']],
    ]
  );
});

test('flaky units are keyed by runner identity and project, never by a FAIL id', () => {
  const m = failureMetrics([
    {
      story: 'S-1',
      runId: 'r1',
      failures: [
        pwFailure('TC-001'),
        pwFailure('TC-001', { project: 'firefox' }),
        { failure_id: 'FAIL-003', classification: 'flaky', test_case_id: null },
      ],
    },
    { story: 'S-1', runId: 'r2', failures: [pwFailure('TC-001')] },
  ]);
  assert.deepEqual(
    m.flakiest_tests.map((r) => [r.project, r.flaky_count, r.runs]),
    [
      ['chromium', 2, ['r1', 'r2']],
      ['firefox', 1, ['r1']],
    ]
  );
  assert.equal(m.flaky_without_identity, 1);
  assert.equal(m.failures_without_test_case, 1);
});

const record = (i, outcome) => ({
  run_id: 'run-1',
  outcome,
  unit: { unit_id: `u${i}` },
  original: { sha256: 'a'.repeat(64) },
  candidate: { sha256: String(i).repeat(64) },
});
const file = (name, value) => ({
  name,
  text: typeof value === 'string' ? value : JSON.stringify(value),
});

test('the healer rate is validated over unique submissions; notes are never successes', () => {
  const m = healerMetrics(
    [
      {
        files: [
          file('FAIL-001.attempt-1.json', record(1, 'validated')),
          file(
            'FAIL-001.attempt-1.md',
            '# FAIL-001 — candidate attempt 1: validated'
          ),
          file('FAIL-002.attempt-1.json', record(2, 'validation_failed')),
          file('FAIL-003.attempt-1.json', record(3, 'rejected_static')),
          file(
            'FAIL-004.md',
            '# FAIL-004 — Yellow (suggestion only)\n\nno patch'
          ),
          file(
            'FAIL-005.exhausted.md',
            '# FAIL-005 — healing attempts exhausted'
          ),
          file(
            'FAIL-006.md',
            '# FAIL-006 validated patch (old free-form note)'
          ),
          file('FAIL-007.attempt-1.json', '{not json'),
        ],
      },
      // The same run's evidence archived a second time.
      { files: [file('FAIL-001.attempt-1.json', record(1, 'validated'))] },
    ],
    () => true
  );
  assert.equal(m.submissions, 3);
  assert.equal(m.validated, 1);
  assert.equal(m.success_rate, 1 / 3);
  assert.equal(m.duplicate_records, 1);
  assert.equal(m.yellow_suggestions, 1);
  assert.equal(m.exhausted_notices, 1);
  assert.equal(m.legacy_markdown_notes, 1);
  assert.equal(m.invalid_records, 1);
});

test('Yellow-only, legacy-only or invalid evidence leaves the rate unknown, not 100%', () => {
  for (const files of [
    [file('FAIL-001.md', '# FAIL-001 — Yellow (suggestion only)')],
    [file('FAIL-002.md', 'Patch looks good')],
    [file('FAIL-003.attempt-1.json', record(1, 'validated'))],
  ]) {
    const m = healerMetrics([{ files }], () => false);
    assert.equal(m.submissions, 0);
    assert.equal(m.success_rate, null);
  }
});

test('the CLI: duplicate archives count once, real records are schema-checked, and no sample reads as unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-metrics-'));
  try {
    mkdirSync(join(dir, 'runs'));
    const rec = JSON.parse(
      readFileSync(
        join(
          REPO,
          'examples/expected/locator-repair.expected-healer-validation.json'
        ),
        'utf8'
      )
    );
    const put = (story, dirName, id, withHealer) => {
      const base = join(dir, 'runs', story, dirName);
      mkdirSync(join(base, 'analysis', 'healer-validation'), {
        recursive: true,
      });
      mkdirSync(join(base, 'release'), { recursive: true });
      writeFileSync(
        join(base, 'context.json'),
        JSON.stringify({
          status: 'completed',
          run_id: id,
          risks: [{ risk_id: 'RISK-001', severity: 'high' }],
        })
      );
      writeFileSync(
        join(base, 'analysis', 'failure-analysis.json'),
        JSON.stringify({
          run_id: id,
          failures: [pwFailure('TC-001', { classification: 'product_bug' })],
        })
      );
      writeFileSync(
        join(base, 'release', 'release-report.json'),
        JSON.stringify({
          coverage_by_risk: [{ risk_id: 'RISK-001', status: 'uncovered' }],
        })
      );
      if (withHealer) {
        const hv = join(base, 'analysis', 'healer-validation');
        writeFileSync(join(hv, 'FAIL-001.attempt-1.json'), JSON.stringify(rec));
        writeFileSync(
          join(hv, 'FAIL-002.attempt-1.json'),
          JSON.stringify({ ...rec, patch: null })
        );
      }
    };
    put('STORY-001', 'a', 'run-1', true);
    put('STORY-001', 'b-copy', 'run-1', true); // the same run, archived twice
    put('STORY-002', 'a', 'run-2', false);

    const r = spawnSync(
      execPath,
      [join(REPO, 'scripts', 'pipeline-metrics.js')],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(
      readFileSync(join(dir, 'metrics', 'pipeline-metrics.json'), 'utf8')
    );
    assert.equal(m.total_runs, 2);
    assert.equal(m.duplicate_run_archives, 1);
    assert.equal(m.product_bugs_found_by_generated_tests.count, 2);
    assert.deepEqual(
      m.top_failing_test_cases.map((t) => `${t.story} ${t.test_case_id}`),
      ['STORY-001 TC-001', 'STORY-002 TC-001']
    );
    assert.equal(m.healer_patch_validation.submissions, 1);
    assert.equal(m.healer_patch_validation.success_rate, 1);
    assert.equal(
      m.healer_patch_validation.invalid_records,
      1,
      'a validated record without its patch is not valid evidence'
    );
    assert.deepEqual(
      m.untested_high_risk_items.map((u) => `${u.story}:${u.risk_id}`),
      ['STORY-001:RISK-001', 'STORY-002:RISK-001']
    );

    const e = spawnSync(
      execPath,
      [join(REPO, 'scripts', 'evolve.js'), '--json'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.match(e.stdout, /"theme": "untested-high-risk-items"/);
    assert.match(e.stdout, /STORY-001 \(run-1\): RISK-001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const empty = mkdtempSync(join(tmpdir(), 'qaizen-metrics-'));
  try {
    mkdirSync(join(empty, 'runs', 'S-1', 'r'), { recursive: true });
    writeFileSync(join(empty, 'runs', 'S-1', 'r', 'run-manifest.json'), '{}');
    const r = spawnSync(
      execPath,
      [join(REPO, 'scripts', 'pipeline-metrics.js'), '--dry-run'],
      { cwd: empty, encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /Unknown: no run has a failure analysis, so absence here proves nothing/
    );
    assert.match(r.stdout, /Unknown: no run has risk coverage/);
    assert.match(
      r.stdout,
      /Success rate \(validated \/ submissions\): n\/a — no structured submission yet/
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
