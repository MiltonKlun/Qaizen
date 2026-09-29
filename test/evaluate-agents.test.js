// The structural evaluator: declared coverage, exact arithmetic, and the
// candidate side of the prompt-change workflow (task group 8.1, finding I5).
//
// Each test builds a throwaway dataset (stories, gold outputs, manifest,
// agent prompts) and runs scripts/evaluate-agents.js in it, so no committed
// file is read as the subject or written.

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
