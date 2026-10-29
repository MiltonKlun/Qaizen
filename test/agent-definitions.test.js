// The generated Playwright agents are checked against the project's
// permission policy (scripts/check-agent-definitions.js): an agent granted a
// tool that runs arbitrary code must be covered by a deny rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentDefinitionProblems,
  isDenied,
  parseAgentDefinition,
} from '../scripts/lib/agent-definitions.js';

const UNSAFE = 'mcp__playwright-test__browser_run_code_unsafe';
const planner = (tools) =>
  `---\nname: playwright-test-planner\ntools: Glob, Read, ${tools}\nmodel: sonnet\n---\n\nYou are a planner.\n`;

test('parses the name, tools and body of a generated agent', () => {
  const a = parseAgentDefinition('p.md', planner(UNSAFE));
  assert.equal(a.name, 'playwright-test-planner');
  assert.deepEqual(a.tools, ['Glob', 'Read', UNSAFE]);
  assert.match(a.body, /You are a planner/);
});

test('an agent with no tools field inherits every tool', () => {
  const a = parseAgentDefinition(
    'p.md',
    '---\nname: playwright-test-planner\nmodel: sonnet\n---\n\nPlan.\n'
  );
  assert.equal(a.tools, null);
  const { problems } = agentDefinitionProblems([a], null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /inherits/);
});

test('YAML-list tools and a byte-order mark parse the same way', () => {
  const a = parseAgentDefinition(
    'p.md',
    `\uFEFF---\nname: playwright-test-planner\ntools:\n  - Read\n  - ${UNSAFE}\n---\n\nPlan.\n`
  );
  assert.deepEqual(a.tools, ['Read', UNSAFE]);
});

test('a deny rule covers the tool by exact name or by glob', () => {
  assert.equal(isDenied(UNSAFE, [UNSAFE]), true);
  assert.equal(isDenied(UNSAFE, ['mcp__*']), true);
  assert.equal(isDenied(UNSAFE, ['mcp__playwright-test__*']), true);
  assert.equal(isDenied(UNSAFE, ['mcp__playwright-test']), true);
  assert.equal(isDenied(UNSAFE, ['mcp__playwright']), false);
  assert.equal(isDenied(UNSAFE, ['mcp__postman__*']), false);
  assert.equal(isDenied(UNSAFE, ['Bash(git push *)']), false);
  assert.equal(isDenied(UNSAFE, []), false);
});

test('an unsafe tool is a problem unless the settings deny it', () => {
  const agents = [parseAgentDefinition('p.md', planner(UNSAFE))];
  assert.equal(agentDefinitionProblems(agents, null).problems.length, 1);
  assert.equal(
    agentDefinitionProblems(agents, { permissions: { deny: [UNSAFE] } })
      .problems.length,
    0
  );
  const safe = [parseAgentDefinition('p.md', planner('Grep'))];
  assert.deepEqual(agentDefinitionProblems(safe, null).problems, []);
});

test('a healer allowed to fix assertions is a warning, not a failure', () => {
  const healer = parseAgentDefinition(
    'h.md',
    '---\nname: playwright-test-healer\ntools: Read, Edit\n---\n\n- Fixing assertions and expected values\n'
  );
  const { problems, warnings } = agentDefinitionProblems([healer], null);
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /native-healer-handoff/);
});

test('the CLI fails on an undenied unsafe tool and passes once it is denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-agents-'));
  try {
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'p.md'), planner(UNSAFE));
    const run = (/** @type {object} */ settings) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
      return spawnSync(
        process.execPath,
        [
          'scripts/check-agent-definitions.js',
          '--dir',
          join(dir, 'agents'),
          '--settings',
          join(dir, 'settings.json'),
        ],
        { encoding: 'utf8' }
      );
    };
    const bad = run({ permissions: { deny: [] } });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /browser_run_code_unsafe/);
    const good = run({ permissions: { deny: [UNSAFE] } });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tracked project settings deny the unsafe tool', async () => {
  const { readFileSync } = await import('node:fs');
  const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
  assert.equal(isDenied(UNSAFE, settings.permissions.deny), true);
  assert.ok(settings.permissions.deny.includes('Read(./.env)'));
  // A Jira or TestLink write script never runs without the operator's yes.
  for (const shell of ['Bash', 'PowerShell']) {
    assert.ok(settings.permissions.ask.includes(`${shell}(*--apply*)`), shell);
  }
});
