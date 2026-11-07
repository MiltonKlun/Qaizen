// What produced each artifact (scripts/lib/provenance.js): every agent step's
// prompt files by digest, the declared model and harness, the output and the
// date; Gate 3 binds the Planner's and Generator's prompt files, so editing
// one after Gate 3 makes it stale; --status shows the provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  GATE3_PROMPTS,
  STEP_PROMPTS,
  UNKNOWN,
  needsProvenance,
  promptDigests,
  provenanceLines,
  stepOutputs,
  stepProvenance,
} from '../scripts/lib/provenance.js';
import { STEP_MCP } from '../scripts/lib/step-mcp.js';
import {
  BINDING_VERSION,
  bindingFor,
  bindingState,
} from '../scripts/lib/approval-binding.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { removeTempDir } from './helpers/cleanup.js';
import { runContext, scopeCases } from './helpers/valid-run.js';
import { copyRuntimeConfig } from './helpers/runtime-config.js';

const REPO = process.cwd();

test('every agent step maps its prompt files, and each tracked one exists', () => {
  const agentSteps = Object.keys(STEP_MCP).filter((s) => s !== 'healer');
  assert.deepEqual(Object.keys(STEP_PROMPTS).sort(), agentSteps.sort());
  for (const [step, files] of Object.entries(STEP_PROMPTS))
    for (const f of files)
      if (!f.startsWith('.claude/'))
        assert.ok(existsSync(join(REPO, f)), `${step}: ${f}`);
  // Each agent prompt's own skills are among its step's files.
  for (const [step, files] of Object.entries(STEP_PROMPTS)) {
    const agent = files.find((f) => f.startsWith('agents/'));
    if (!agent || step === 'external-plan') continue;
    const skills = [
      ...new Set(
        readFileSync(join(REPO, agent), 'utf8').match(/skills\/[a-z-]+/g) ?? []
      ),
    ].map((s) => `${s}/SKILL.md`);
    for (const s of skills) assert.ok(files.includes(s), `${step}: ${s}`);
  }
  assert.deepEqual(GATE3_PROMPTS, [
    '.claude/agents/playwright-test-planner.md',
    '.claude/agents/playwright-test-generator.md',
  ]);
});

test('a step records its prompt digests, the declared model and harness, and its output', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-prov-'));
  t.after(() => removeTempDir(dir));
  mkdirSync(join(dir, 'agents'));
  mkdirSync(join(dir, 'skills', 'receiving-tickets'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'analyst.md'), 'analyst\r\nprompt\r\n');
  const p = stepProvenance('analyst', {
    root: dir,
    output: { path: 'context.json', sha256: 'a'.repeat(64) },
    env: { QAIZEN_MODEL: 'claude-opus-5-5', QAIZEN_HARNESS: 'claude-code 2.4' },
    now: '2026-11-07T00:00:00Z',
  });
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.harness, 'claude-code 2.4');
  // Line endings do not change a digest; a missing file is null.
  const [analyst, skill] = p.prompts;
  assert.equal(
    analyst.sha256,
    promptDigests(['agents/analyst.md'], dir)[0].sha256
  );
  writeFileSync(join(dir, 'agents', 'analyst.md'), 'analyst\nprompt\n');
  assert.equal(
    promptDigests(['agents/analyst.md'], dir)[0].sha256,
    analyst.sha256
  );
  assert.deepEqual(skill, {
    path: 'skills/receiving-tickets/SKILL.md',
    sha256: null,
  });
  // Undeclared: unknown, never a guess.
  const anon = stepProvenance('analyst', {
    root: dir,
    output: { path: 'context.json', sha256: 'a'.repeat(64) },
  });
  assert.deepEqual([anon.model, anon.harness], [UNKNOWN, UNKNOWN]);
  assert.throws(() =>
    stepProvenance('healer', {
      root: dir,
      output: { path: 'x', sha256: 'a'.repeat(64) },
    })
  );
  // Recorded again only when the output changes.
  const ctx = { provenance: { analyst: p } };
  assert.equal(needsProvenance(ctx, 'analyst', 'a'.repeat(64)), false);
  assert.equal(needsProvenance(ctx, 'analyst', 'b'.repeat(64)), true);
  assert.equal(needsProvenance({}, 'planner', 'a'.repeat(64)), true);
});

test('the Test Designer output leaves out the per-case decisions the reviewer records', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-prov-out-'));
  t.after(() => removeTempDir(dir));
  const ctx = runContext({ storyId: 'PV-1', runId: 'run-pv-1' });
  const doc = scopeCases('PV-1', 'run-pv-1');
  mkdirSync(join(dir, 'test-cases'));
  const write = () =>
    writeFileSync(join(dir, 'test-cases', 'PV-1.json'), JSON.stringify(doc));
  write();
  const before = stepOutputs(ctx, dir)['test-designer'];
  doc.test_cases[0].status = 'rejected';
  write();
  assert.deepEqual(stepOutputs(ctx, dir)['test-designer'], before);
  // Nor the ids a TestLink or Jira sync writes back into the cases.
  doc.test_cases[0].testlink_id = '1234';
  doc.test_cases[0].sync_state = { testlink: 'synced' };
  write();
  assert.deepEqual(stepOutputs(ctx, dir)['test-designer'], before);
  // The planner brief is part of the Test Designer's output.
  mkdirSync(join(dir, 'planner-input'));
  writeFileSync(join(dir, ctx.artifact_paths.planner_brief), 'Brief.\n');
  const withBrief = stepOutputs(ctx, dir)['test-designer'];
  assert.notDeepEqual(withBrief, before);
  writeFileSync(
    join(dir, ctx.artifact_paths.planner_brief),
    'Brief, redone.\n'
  );
  assert.notDeepEqual(stepOutputs(ctx, dir)['test-designer'], withBrief);
  doc.test_cases[0].title = 'another title';
  write();
  assert.notDeepEqual(stepOutputs(ctx, dir)['test-designer'], before);
  // Steps with nothing produced yet have no output.
  assert.equal(stepOutputs(ctx, dir).planner, null);
  assert.equal(stepOutputs(null, dir).analyst, null);
});

/** A run with Gate 3 approved under the current binding, in its own folder. */
function gate3Run(t) {
  const dir = mkdtempSync(join(REPO, '.tmp-prov-g3-'));
  t.after(() => removeTempDir(dir));
  const ctx = runContext({ storyId: 'PV-1', runId: 'run-pv-1', gates: false });
  ctx.artifact_paths.playwright_spec = 'specs/PV-1.md';
  mkdirSync(join(dir, 'specs'));
  writeFileSync(join(dir, 'specs', 'PV-1.md'), '# SPEC-001\n');
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  for (const p of GATE3_PROMPTS) writeFileSync(join(dir, p), `${p} v1\n`);
  ctx.review_gates.specs_reviewed = {
    status: true,
    reviewer: 'h',
    reviewed_at: '2026-11-07T00:00:00Z',
    ...bindingFor('specs_reviewed', ctx, dir),
  };
  return { dir, ctx };
}

test('editing the Planner or Generator prompt after Gate 3 makes Gate 3 stale', (t) => {
  for (const p of GATE3_PROMPTS) {
    const { dir, ctx } = gate3Run(t);
    assert.equal(ctx.review_gates.specs_reviewed.binding_version, 3);
    assert.equal(BINDING_VERSION, 3);
    assert.equal(bindingState('specs_reviewed', ctx, dir).state, 'current');
    writeFileSync(join(dir, p), `${p} v2\n`);
    const s = bindingState('specs_reviewed', ctx, dir);
    assert.equal(s.state, 'stale');
    assert.deepEqual(s.changed, [`prompt:${p}`]);
  }
  // A declared version string no longer stands for the prompt.
  const { dir, ctx } = gate3Run(t);
  ctx.prompt_versions = { planner: '9.9.9' };
  assert.equal(bindingState('specs_reviewed', ctx, dir).state, 'current');
});

test('a Gate 3 approved under binding version 2 keeps verifying by its declared versions', (t) => {
  const { dir, ctx } = gate3Run(t);
  ctx.prompt_versions = { planner: '1.0.0' };
  // As an older checkout recorded it.
  const { binding_version: _v, ...v3 } = ctx.review_gates.specs_reviewed;
  void _v;
  const legacy = { ...ctx };
  legacy.review_gates = {
    ...ctx.review_gates,
    specs_reviewed: { ...v3, binding_version: 2 },
  };
  // Recompute its digest the v2 way, then edit a prompt: v2 does not see it.
  legacy.review_gates.specs_reviewed.input_digest = bindingState(
    'specs_reviewed',
    legacy,
    dir
  ).current_digest;
  assert.equal(bindingState('specs_reviewed', legacy, dir).state, 'current');
  writeFileSync(join(dir, GATE3_PROMPTS[0]), 'edited\n');
  assert.equal(bindingState('specs_reviewed', legacy, dir).state, 'current');
  legacy.prompt_versions = { planner: '1.0.1' };
  assert.equal(bindingState('specs_reviewed', legacy, dir).state, 'stale');
});

test('the context schema accepts provenance and refuses a step it does not know', () => {
  const ctx = JSON.parse(
    readFileSync(
      join(REPO, 'examples', 'expected', 'provenance.expected-context.json'),
      'utf8'
    )
  );
  const schema = join(REPO, 'schemas', 'context.schema.json');
  assert.equal(validateValue(ctx, schema).ok, true);
  ctx.provenance.healer = ctx.provenance.analyst;
  assert.equal(validateValue(ctx, schema).ok, false);
});

test('a gate decision keeps provenance, and --status shows it, unknown where nothing was recorded', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-prov-run-'));
  t.after(() => removeTempDir(dir));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  // The prompt files are read from the repository the scripts run from.
  cpSync(join(REPO, 'agents'), join(dir, 'agents'), { recursive: true });
  cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true });
  copyRuntimeConfig(dir, REPO);
  const ctx = runContext({
    storyId: 'PV-1',
    runId: 'run-pv-1',
    status: 'draft',
    gates: false,
  });
  writeFileSync(join(dir, 'story.md'), '# PV-1\n\n1. a\n');
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  const status = () =>
    spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'run-pipeline.js'), '--status'],
      {
        cwd: dir,
        encoding: 'utf8',
      }
    ).stdout;
  assert.match(status(), /Provenance:\n {2}analyst: unknown \(not recorded\)/);
  // --status wrote nothing.
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')).provenance,
    undefined
  );

  // The decision is recorded through the runner's own function, in-process.
  const code = `
    import { recordGateDecision } from './scripts/run-pipeline.js';
    import { bindingFor } from './scripts/lib/approval-binding.js';
    import { readFileSync } from 'node:fs';
    const context = JSON.parse(readFileSync('context.json', 'utf8'));
    const r = recordGateDecision({
      context, step: 'gate1', gateKey: 'requirements_reviewed',
      decision: 'approved', reviewer: 'h', notes: null,
      openedAt: '2026-11-07T00:00:00Z', decidedAt: '2026-11-07T00:01:00Z',
      bindings: { requirements_reviewed: bindingFor('requirements_reviewed', context, '.') },
      brief: 'BRIEF',
    });
    if (!r.ok) { console.error(r.message); process.exit(1); }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, QAIZEN_MODEL: 'claude-opus-5-5' },
  });
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
  assert.equal(saved.provenance.analyst.model, 'claude-opus-5-5');
  assert.equal(saved.provenance.analyst.output.path, 'context.json');
  assert.deepEqual(
    saved.provenance.analyst.prompts.map((p) => p.path),
    STEP_PROMPTS.analyst
  );
  assert.ok(
    saved.provenance.analyst.prompts.every((p) =>
      /^[a-f0-9]{64}$/.test(p.sha256)
    )
  );
  assert.match(
    status(),
    /Provenance:\n {2}analyst: agents\/analyst\.md [a-f0-9]{12}, skills\/receiving-tickets\/SKILL\.md [a-f0-9]{12}; model claude-opus-5-5, harness unknown, /
  );
  assert.deepEqual(provenanceLines({}, []), []);
});
