#!/usr/bin/env node
// @ts-check
// Check the generated Playwright native agents (.claude/agents/*.md) against
// the project's permission policy (.claude/settings.json). Run it after every
// `npx playwright init-agents`: the files are untracked, so CI never sees them.
//
// Usage:
//   npm run check:agents
//   npm run check:agents -- --dir <agents dir> --settings <settings.json>
//
// Exit codes: 0 ok (warnings may be printed) · 1 a problem found · 2 usage error

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

import { parseCliOrExit } from './lib/cli.js';
import {
  agentDefinitionProblems,
  parseAgentDefinition,
} from './lib/agent-definitions.js';

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/check-agent-definitions.js [--dir .claude/agents] [--settings .claude/settings.json]',
  positionals: [],
  options: {
    dir: { type: 'string' },
    settings: { type: 'string' },
  },
});

const dir =
  /** @type {string | undefined} */ (cli.values.dir) ?? '.claude/agents';
const settingsPath =
  /** @type {string | undefined} */ (cli.values.settings) ??
  '.claude/settings.json';

if (!existsSync(dir)) {
  console.log(
    `No generated agents in ${dir}. Run \`npx playwright init-agents --loop=claude\`, then this check.`
  );
  exit(0);
}

const agents = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => parseAgentDefinition(f, readFileSync(join(dir, f), 'utf8')));
const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, 'utf8'))
  : null;

const { problems, warnings } = agentDefinitionProblems(agents, settings);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const p of problems) console.error(`FAIL  ${p}`);
if (problems.length) exit(1);
console.log(
  `OK  ${agents.length} generated agent(s) checked against ${settingsPath}.`
);
