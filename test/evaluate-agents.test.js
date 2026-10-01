// The structural evaluator: declared coverage, exact arithmetic, and the
// candidate side of the prompt-change workflow (task group 8.1, finding I5;
// the reporter stage, task group 2.2b).
//
// Each test builds a throwaway dataset (stories, gold outputs, manifest,
// agent prompts) and runs scripts/evaluate-agents.js in it, so no committed
// file is written. The last test checks the committed reporter inputs
// themselves, since every reporter candidate starts from them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts', 'evaluate-agents.js');
const gold = (name) =>
  JSON.parse(readFileSync(join(REPO, 'examples', 'expected', name), 'utf8'));
const LOGIN_CTX = gold('login-success.expected-context.json');
const LOGIN_TC = gold('login-success.expected-test-cases.json');

function write(dir, rel, value) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(
    join(dir, rel),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  );
}

/**
 * A dataset: `stories` maps a story name to what exists for it
 * ({ ctx, tc } documents, either may be absent) and `manifest` to its
 * declared expectation.
 */
function dataset(stories, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-eval-'));
  for (const a of ['analyst.md', 'test-designer.md'])
    cpSync(join(REPO, 'agents', a), join(dir, 'agents', a));
  for (const [name, s] of Object.entries(stories)) {
    write(
      dir,
      `examples/stories/${name}.md`,
      `# ${name} (${s.id ?? 'STORY-001'})\n`
    );
    if (s.ctx)
      write(dir, `examples/expected/${name}.expected-context.json`, s.ctx);
    if (s.tc)
      write(dir, `examples/expected/${name}.expected-test-cases.json`, s.tc);
  }
  write(dir, 'examples/evaluation/manifest.json', {
    schema_version: '1.0',
    stories: Object.entries(manifest).map(([story, expected]) => ({
      story,
      expected,
      ...(expected === 'designer' ? {} : { reason: 'declared for the test' }),
    })),
  });
  return dir;
}

function evaluate(dir, args = []) {
  const r = spawnSync(execPath, [SCRIPT, '--out', 'out.json', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  const outPath = join(dir, 'out.json');
  return {
    code: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    results: existsSync(outPath)
      ? JSON.parse(readFileSync(outPath, 'utf8'))
      : null,
  };
}

const withStory = (id, ctx = LOGIN_CTX, tc = LOGIN_TC) => ({
  id,
  ctx: { ...ctx, story: { ...ctx.story, id } },
  tc: { ...tc, story_id: id },
});

// ------------------------------------------------------------ the manifest

test('every story must be declared, and every declared story must exist', () => {
  const dir = dataset(
    { a: withStory('STORY-001'), b: withStory('STORY-002') },
    { a: 'designer' }
  );
  try {
    let r = evaluate(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /b\.md has no manifest entry/);

    write(dir, 'examples/evaluation/manifest.json', {
      schema_version: '1.0',
      stories: [
        { story: 'a', expected: 'designer' },
        { story: 'b', expected: 'designer' },
        { story: 'ghost', expected: 'none', reason: 'x' },
      ],
    });
    r = evaluate(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /"ghost" is listed but/);

    // An analyst/none entry without a reason is an invalid manifest.
    write(dir, 'examples/evaluation/manifest.json', {
      schema_version: '1.0',
      stories: [
        { story: 'a', expected: 'designer' },
        { story: 'b', expected: 'analyst' },
      ],
    });
    r = evaluate(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /manifest\.json is missing or invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declared Designer output that is missing fails, and stays in the report', () => {
  const s = withStory('STORY-002');
  delete s.tc;
  const dir = dataset(
    { a: withStory('STORY-001'), b: s },
    { a: 'designer', b: 'designer' }
  );
  try {
    const r = evaluate(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(
      r.out,
      /MISSING b \(designer\): .*expected-test-cases\.json is declared but missing/
    );
    assert.deepEqual(r.results.counts.scored, { designer: 1, analyst: 0 });
    assert.equal(r.results.counts.missing, 1);
    assert.equal(r.results.missing[0].story, 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Analyst-only gold is labelled and never counted as a tested Designer output', () => {
  const s = withStory('STORY-002');
  const dir = dataset(
    { a: withStory('STORY-001'), b: s, c: { id: 'STORY-003' } },
    { a: 'designer', b: 'analyst', c: 'none' }
  );
  try {
    const r = evaluate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /OK b: 100% \(16\/16\) \[analyst-only: not a tested Designer output\]/
    );
    assert.deepEqual(r.results.counts.declared, {
      designer: 1,
      analyst: 1,
      none: 1,
    });
    assert.deepEqual(r.results.counts.scored, { designer: 1, analyst: 1 });
    // Its test cases exist, but the declaration decides: they are not scored.
    assert.equal(
      r.results.results.find((x) => x.story === 'b').sources.test_cases,
      null
    );
    assert.deepEqual(r.results.excluded, [
      { story: 'c', reason: 'declared for the test' },
    ]);
    assert.match(r.out, /does not evaluate prompt behavior/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cohort with nothing to score fails', () => {
  const dir = dataset({ a: { id: 'STORY-001' } }, { a: 'none' });
  try {
    const r = evaluate(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Nothing was scored/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ the checks

test('the arithmetic is exact: 199 of 200 checks is 99.5%, never a rounded 100%', () => {
  const stories = {};
  const manifest = {};
  for (let i = 1; i <= 8; i += 1) {
    stories[`s${i}`] = withStory(`STORY-00${i}`);
    manifest[`s${i}`] = 'designer';
  }
  // One structural defect that the schema cannot see: a case filed under
  // another story.
  stories.s8.tc = { ...stories.s8.tc, story_id: 'STORY-099' };
  const dir = dataset(stories, manifest);
  try {
    const r = evaluate(dir);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.results.checks, { passed: 199, total: 200 });
    assert.equal(r.results.match_pct, 99.5);
    assert.match(r.out, /Overall: 99\.5% \(199\/200 checks\)/);
    assert.match(r.out, /FAIL: story_id matches context\.story\.id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema validity and cross-artifact links are counted checks, not skipped', () => {
  const s = withStory('STORY-001');
  delete s.ctx.story.title;
  s.tc.test_cases = s.tc.test_cases.map((c, i) =>
    i === 0 ? { ...c, acceptance_criteria_refs: [99] } : c
  );
  const dir = dataset({ a: s }, { a: 'designer' });
  try {
    const r = evaluate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /FAIL: context validates against its schema — \/story must have required property 'title'/
    );
    assert.match(
      r.out,
      /FAIL: every TC acceptance_criteria_ref is a real AC — TC-001\.acceptance_criteria_refs\[99\]/
    );
    assert.equal(r.results.checks.total, 25, 'the denominator did not shrink');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ candidates

function candidate(
  dir,
  { id = 'STORY-001', versions, tc = true, mutate } = {}
) {
  const c = join(dir, 'run');
  const s = withStory(id);
  if (mutate) mutate(s);
  write(c, 'context.json', {
    ...s.ctx,
    ...(versions ? { prompt_versions: versions } : {}),
  });
  if (tc) write(c, `test-cases/${id}.json`, s.tc);
  return c;
}

test('a candidate is scored with its prompt identity and saved next to it, not over the dataset', () => {
  const dir = dataset({ a: withStory('STORY-001') }, { a: 'designer' });
  try {
    const run = candidate(dir);
    const r = spawnSync(execPath, [SCRIPT, '--candidate-dir', 'run'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const res = JSON.parse(
      readFileSync(join(run, 'evaluation-results.json'), 'utf8')
    );
    assert.equal(
      existsSync(join(dir, 'examples/evaluation/latest-results.json')),
      false
    );
    assert.equal(res.kind, 'candidate-evaluation');
    assert.equal(res.candidate.story, 'a');
    for (const name of ['analyst', 'test-designer']) {
      assert.match(res.candidate.prompts[name].version, /^\d+\.\d+\.\d+$/);
      assert.match(res.candidate.prompts[name].sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(res.baseline.source, 'gold:a (designer)');
    assert.deepEqual(res.baseline.regressions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate must come from a fixed story, and from the prompts being recorded', () => {
  const dir = dataset({ a: withStory('STORY-001') }, { a: 'designer' });
  try {
    candidate(dir, { id: 'STORY-404' });
    let r = evaluate(dir, ['--candidate-dir', 'run']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /STORY-404 is not one of the fixed evaluation stories/);

    rmSync(join(dir, 'run'), { recursive: true, force: true });
    candidate(dir, { versions: { analyst: '0.0.1' } });
    r = evaluate(dir, ['--candidate-dir', 'run']);
    assert.equal(r.code, 2, r.out);
    assert.match(
      r.out,
      /produced with analyst 0\.0\.1, but agents[\\/]analyst\.md is/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate is compared with its baseline: regressions are named, a drop over 10 points is flagged', () => {
  const dir = dataset({ a: withStory('STORY-001') }, { a: 'designer' });
  try {
    // A candidate whose cases lost their risk links and decision reasons.
    candidate(dir, {
      mutate: (s) => {
        s.tc.test_cases = s.tc.test_cases.map((c) => ({
          ...c,
          risk_ids: ['RISK-999'],
          automation_decision_reason: '',
        }));
      },
    });
    // The gold baseline, as a previous results file.
    const base = evaluate(dir);
    assert.equal(base.code, 0, base.out);
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(base.results));

    const r = evaluate(dir, [
      '--candidate-dir',
      'run',
      '--baseline',
      'baseline.json',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REGRESSED: every TC links to a real RISK/);
    assert.match(r.out, /REGRESSED: every context risk is covered by a TC/);
    assert.equal(r.results.baseline.source, 'baseline.json');
    assert.ok(r.results.baseline.match_pct_delta < -10, r.out);
    assert.equal(r.results.baseline.needs_rework_signal, true);
    assert.match(r.out, /documented "needs rework" signal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- the reporter stage (2.2b)

const INPUTS = join(REPO, 'examples/evaluation/reporter-inputs/login-success');

/** A copy of the reporter inputs in `dir/run`, with the prompt version set. */
function reporterCandidate(dir) {
  cpSync(
    join(REPO, 'agents', 'reporter.md'),
    join(dir, 'agents', 'reporter.md')
  );
  const run = join(dir, 'run');
  cpSync(INPUTS, run, { recursive: true });
  const version = /^version:\s*(\S+)/m.exec(
    readFileSync(join(REPO, 'agents', 'reporter.md'), 'utf8')
  )[1];
  const ctx = JSON.parse(readFileSync(join(run, 'context.json'), 'utf8'));
  ctx.prompt_versions.reporter = version;
  write(run, 'context.json', ctx);
  return run;
}

/** The release report a correct Reporter writes for the inputs. */
async function correctReport(run) {
  const { releaseExecutionSummary } =
    await import('../scripts/lib/execution-ledger.js');
  const read = (p) => JSON.parse(readFileSync(join(run, p), 'utf8'));
  const ctx = read('context.json');
  return {
    schema_version: '2.0',
    run_id: ctx.run_id,
    story_id: ctx.story.id,
    report_date: '2026-10-01T12:00:00Z',
    summary: 'Login: a Red API failure (BUG-001) and a flaky E2E case.',
    coverage_by_risk: [
      {
        risk_id: 'RISK-001',
        covered_by_tcs: ['TC-001', 'TC-002', 'TC-004'],
        status: 'covered_failing',
      },
      {
        risk_id: 'RISK-002',
        covered_by_tcs: ['TC-003'],
        status: 'covered_failing',
      },
    ],
    execution_summary: releaseExecutionSummary(
      read('analysis/execution-ledger.json')
    ),
    uncovered_risks: [],
    uncovered_high_severity_count: 0,
    flaky_tests: [{ test_id: 'PW-002', branch: 'e2e' }],
    blocking_failures: ['FAIL-001'],
    non_blocking_failures: ['FAIL-002'],
    release_recommendation: 'fail',
    release_recommendation_reasoning:
      'FAIL-001 is Red on a high-severity risk.',
    bug_drafts: [
      {
        bug_id: 'BUG-001',
        severity: 'red',
        path: 'release/bug-drafts/BUG-001.md',
      },
    ],
    evidence_paths: ['analysis/failure-analysis.json'],
    open_questions: [],
    status: 'finalized',
  };
}

test('the reporter stage scores a release report against its own run', async () => {
  const dir = dataset(
    { 'login-success': withStory('STORY-001') },
    { 'login-success': 'designer' }
  );
  try {
    const run = reporterCandidate(dir);
    const report = await correctReport(run);
    write(run, 'release/release-report.json', report);
    const ok = evaluate(dir, ['--candidate-dir', 'run', '--stage', 'reporter']);
    assert.equal(ok.code, 0, ok.out);
    const res = ok.results.results[0];
    assert.equal(res.stage, 'reporter');
    assert.equal(res.passed, res.total);
    assert.match(
      ok.results.candidate.prompts.reporter.sha256,
      /^[0-9a-f]{64}$/
    );
    // No gold release report exists, so there is no implicit baseline.
    assert.equal(ok.results.baseline, undefined);
    assert.match(ok.out, /no gold release report/);

    // A hand-edited count and a pass despite a Red failure are both caught.
    const bad = structuredClone(report);
    bad.execution_summary.e2e.outcome_breakdown.flaky = 0;
    bad.execution_summary.e2e.outcome_breakdown.failed = 1;
    bad.release_recommendation = 'pass';
    write(run, 'release/release-report.json', bad);
    const caught = evaluate(dir, [
      '--candidate-dir',
      'run',
      '--stage',
      'reporter',
    ]);
    assert.equal(caught.code, 1);
    const failed = caught.results.results[0].failed_checks.map((c) => c.name);
    assert.ok(
      failed.includes('execution_summary is the one derived from the ledger'),
      failed.join()
    );
    assert.ok(
      failed.includes(
        'the recommendation is never pass while something blocks it'
      ),
      failed.join()
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reporter candidate without its release report is missing work, not a score', () => {
  const dir = dataset(
    { 'login-success': withStory('STORY-001') },
    { 'login-success': 'designer' }
  );
  try {
    reporterCandidate(dir);
    const r = evaluate(dir, ['--candidate-dir', 'run', '--stage', 'reporter']);
    assert.equal(r.code, 2);
    assert.match(r.out, /missing release_report for the reporter stage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed reporter inputs are one coherent, finalized run', async () => {
  const { validateValue } = await import('../scripts/lib/artifact-io.js');
  const { readLedger, analysisCountProblems } =
    await import('../scripts/lib/execution-ledger.js');
  const { findInvalidations } =
    await import('../scripts/lib/approval-binding.js');
  const read = (p) => JSON.parse(readFileSync(join(INPUTS, p), 'utf8'));
  const ctx = read('context.json');
  assert.equal(
    validateValue(ctx, join(REPO, 'schemas/context.schema.json')).ok,
    true
  );
  assert.equal(
    validateValue(
      read('test-cases/STORY-001.json'),
      join(REPO, 'schemas/test-cases.schema.json')
    ).ok,
    true
  );
  const ledger = readLedger(join(INPUTS, 'analysis/execution-ledger.json'), {
    storyId: 'STORY-001',
    runId: ctx.run_id,
  });
  assert.equal(ledger.ok, true, ledger.ok ? '' : ledger.message);
  const fa = read('analysis/failure-analysis.json');
  assert.equal(
    validateValue(fa, join(REPO, 'schemas/failure-analysis.schema.json')).ok,
    true
  );
  assert.equal(fa.status, 'finalized');
  assert.deepEqual(analysisCountProblems(fa), []);
  for (const f of fa.failures.filter((x) => x.severity === 'red')) {
    assert.ok(existsSync(join(INPUTS, f.bug_draft_path)), f.bug_draft_path);
  }
  // Every gate is bound to these exact bytes (a reformat would break it).
  assert.deepEqual(findInvalidations(ctx, INPUTS), []);
});
