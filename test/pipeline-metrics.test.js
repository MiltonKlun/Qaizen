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
