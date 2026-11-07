// Every agent that may find its task impossible is told how to stop: the
// runner's step instruction for the Generator and the API Agent, the API
// Agent's prompt and the native Healer's invocation all carry the same exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { IMPOSSIBLE_LINE } from '../scripts/lib/step-mcp.js';

const read = (/** @type {string} */ p) => readFileSync(p, 'utf8');

test('the step instruction tells the agent to reply IMPOSSIBLE and stop', () => {
  assert.match(
    IMPOSSIBLE_LINE,
    /write\s+nothing, reply "IMPOSSIBLE: <why>" and stop/
  );
  const runner = read('scripts/run-pipeline.js');
  for (const step of ['generator', 'api']) {
    const start = runner.indexOf(`\n  ${step}: (ctx) =>`);
    assert.ok(start > 0, `${step} step found`);
    const body = runner.slice(start, runner.indexOf('--resume', start));
    assert.match(body, /IMPOSSIBLE_LINE/, `${step} step`);
  }
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
