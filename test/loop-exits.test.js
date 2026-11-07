// Every agent that may find its task impossible is told how to stop: the
// runner's step instruction for the Planner, the Generator and the API Agent,
// the API Agent's prompt and the native Healer's invocation all carry the exit,
// and none of them says to change the expected behavior to match the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GUIDE_STEPS } from '../scripts/run-pipeline.js';

const read = (/** @type {string} */ p) => readFileSync(p, 'utf8');
const ctx = /** @type {any} */ ({ story: { id: 'LE-1' }, artifact_paths: {} });

test('the planner, generator and api steps print the exit, and a defect is an answer to it', () => {
  for (const step of ['planner', 'generator', 'api']) {
    const text = GUIDE_STEPS[step](ctx);
    assert.match(
      text,
      /write nothing, reply IMPOSSIBLE: <why> and stop\."/,
      `${step} step`
    );
    assert.match(text, /raise a defect/, step);
    assert.match(
      text,
      /Never change the\s+expected behavior to match the app/,
      step
    );
    // The exit is said before the resume line, not after it.
    assert.ok(text.indexOf('IMPOSSIBLE') < text.indexOf('--resume'), step);
  }
  // Steps with nothing to find impossible do not carry it.
  assert.doesNotMatch(GUIDE_STEPS.analyst(ctx), /IMPOSSIBLE/);
});

test('the API Agent prompt and the Healer invocation carry the exit, with the prompt version bumped', () => {
  const api = read('agents/api-agent.md');
  assert.match(api, /^version: 1\.3\.4$/m);
  assert.match(api, /\*\*The way out\.\*\*[\s\S]*?`IMPOSSIBLE: /);
  assert.match(api, /- 1\.3\.4: PATCH/);
  const healer = read('docs/native-healer-handoff.md');
  const invocation =
    /```text\nPropose a fix[\s\S]*?```/.exec(healer)?.[0] ?? '';
  assert.match(invocation, /reply "IMPOSSIBLE: <why>" and stop/);
});
