// Each agent step runs with only the MCP servers it needs
// (scripts/lib/step-mcp.js). The per-step configs under config/mcp/ must hold
// exactly the reviewed definitions from .mcp.json, so a pin or a read-only
// setting cannot drift between the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  MCP_SETS,
  STEP_MCP,
  launchCommand,
  launchLine,
} from '../scripts/lib/step-mcp.js';

const all = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers;
/** @param {string} name */
const config = (name) =>
  JSON.parse(readFileSync(`config/mcp/${name}.json`, 'utf8')).mcpServers;

test('every per-step config holds exactly its servers, copied from .mcp.json', () => {
  const files = readdirSync('config/mcp')
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(files, Object.keys(MCP_SETS).sort());
  for (const [name, servers] of Object.entries(MCP_SETS)) {
    const got = config(name);
    assert.deepEqual(Object.keys(got).sort(), [...servers].sort(), name);
    for (const server of servers) {
      assert.deepEqual(got[server], all[server], `${name}: ${server} drifted`);
    }
  }
});

test('the step configs together cover every server, and nothing else', () => {
  const used = new Set(Object.values(MCP_SETS).flat());
  assert.deepEqual([...used].sort(), Object.keys(all).sort());
});

test('steps that read untrusted text hold no tool beyond their own job', () => {
  assert.deepEqual(MCP_SETS[STEP_MCP.analyst], ['atlassian', 'github']);
  for (const step of ['planner', 'generator', 'healer']) {
    assert.deepEqual(MCP_SETS[STEP_MCP[step]], ['playwright-test'], step);
  }
  assert.deepEqual(MCP_SETS[STEP_MCP.api], ['postman']);
  for (const step of ['test-designer', 'external-plan', 'finalize', 'report']) {
    assert.deepEqual(MCP_SETS[STEP_MCP[step]], [], step);
  }
});

test('the launch command loads only the step config', () => {
  assert.equal(
    launchCommand('analyst'),
    'claude --strict-mcp-config --mcp-config config/mcp/analyst.json'
  );
  assert.equal(launchCommand('gate4'), null);
  assert.match(launchLine('report'), /no MCP server/);
  assert.match(launchLine('planner'), /playwright-test/);
  assert.throws(() => launchLine('not-a-step'), /no MCP config is mapped/);
});
