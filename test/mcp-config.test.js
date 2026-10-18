// The MCP servers in .mcp.json and the GitHub Actions in the workflows are
// dependencies that run with real tokens (docs/dependency-maintenance.md).
// Each must be pinned, so nothing new runs without a reviewed change, and the
// servers that read untrusted text must stay unable to write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/** @type {Record<string, { command: string, args?: string[], env?: Record<string, string> }>} */
const servers = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers;

const DIGEST = /^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/;
const EXACT_NPM = /^@?[^@\s]+@\d+\.\d+\.\d+$/;
// The GitHub tools the Analyst needs: all three only read.
const GITHUB_READ_TOOLS = [
  'get_commit',
  'get_file_contents',
  'pull_request_read',
];

/** The image or package each server runs, and how it is launched. */
function launched(name) {
  const { command, args = [] } = servers[name];
  if (command === 'docker') return { kind: 'image', ref: args.at(-1) };
  const parts = command === 'cmd' ? args.slice(1) : args;
  const rest = parts[0] === 'npx' ? parts.slice(1) : parts;
  const spec = rest.find((a) => !a.startsWith('-'));
  return {
    kind: 'npx',
    ref: spec,
    flags: rest.filter((a) => a.startsWith('-')),
  };
}

test('every MCP server is pinned to an exact version', () => {
  for (const name of Object.keys(servers)) {
    const { kind, ref } = launched(name);
    if (kind === 'image') {
      assert.match(ref, DIGEST, `${name}: image must carry a tag and a digest`);
    } else if (ref === 'playwright') {
      // `npx playwright` resolves the repository's own @playwright/test,
      // which package-lock.json pins.
      assert.equal(servers[name].args.at(-1), 'run-test-mcp-server', name);
    } else {
      assert.match(
        ref,
        EXACT_NPM,
        `${name}: npx package needs an exact version`
      );
    }
  }
});

test('no MCP server can write to Jira, Confluence or GitHub', () => {
  for (const name of Object.keys(servers)) {
    assert.doesNotMatch(name, /write/i, `${name}: no write-enabled entry`);
  }
  const atlassian = servers.atlassian;
  assert.equal(atlassian.env?.READ_ONLY_MODE, 'true');
  assert.ok(atlassian.args?.includes('READ_ONLY_MODE'));
  const enabled = readFileSync('.env.example', 'utf8').match(
    /^ENABLED_TOOLS=(.*)$/m
  );
  assert.ok(enabled, '.env.example lists ENABLED_TOOLS');
  for (const tool of enabled[1].split(',')) {
    assert.match(tool, /_(get|search)|_get_/, `${tool}: read tools only`);
  }

  const github = servers.github;
  assert.equal(github.env?.GITHUB_READ_ONLY, '1');
  assert.equal(github.env?.GITHUB_LOCKDOWN_MODE, '1');
  assert.deepEqual(
    (github.env?.GITHUB_TOOLS ?? '').split(',').sort(),
    GITHUB_READ_TOOLS,
    'GitHub tools are exactly the reviewed read tools'
  );
  assert.ok(
    !('GITHUB_TOOLSETS' in (github.env ?? {})),
    'no toolsets: tools only'
  );
});

test('Postman runs in its default minimal mode', () => {
  const { flags } = launched('postman');
  assert.deepEqual(
    flags.filter((f) => f !== '-y'),
    [],
    'no --full or --code'
  );
});

test('each container receives only the variables its entry maps', () => {
  for (const [name, server] of Object.entries(servers)) {
    if (server.command !== 'docker') continue;
    const args = server.args ?? [];
    const passed = args.filter((_, i) => args[i - 1] === '-e');
    assert.deepEqual(
      [...passed].sort(),
      Object.keys(server.env ?? {}).sort(),
      `${name}: every -e has a value in env, and nothing else is passed`
    );
  }
});

test('every GitHub Action is pinned by a full commit SHA', () => {
  const dir = '.github/workflows';
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(`${dir}/${file}`, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const uses = line.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (!uses || uses[1].startsWith('./')) return;
      assert.match(
        uses[1],
        /@[0-9a-f]{40}$/,
        `${file}:${i + 1} ${uses[1]} is not pinned by SHA`
      );
      assert.match(
        line,
        /#\s*v\d+\.\d+\.\d+\s*$/,
        `${file}:${i + 1} needs a version comment`
      );
      checked++;
    });
  }
  assert.ok(checked > 0, 'the workflows use at least one Action');
});
