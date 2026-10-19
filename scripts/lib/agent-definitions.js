// @ts-check
// Checks the Playwright native agent definitions that `npx playwright
// init-agents` generates into .claude/agents/. They are untracked and
// regenerated on every Playwright upgrade, so a new release can quietly grant
// an agent a dangerous tool or change its instructions. This compares what the
// generated agents can do with the project's permission policy
// (.claude/settings.json).
//
// Pure: callers pass the parsed definitions and settings.

/**
 * Tools that run arbitrary code. Playwright's MCP documentation calls
 * browser_run_code_unsafe "RCE-equivalent"; an agent that reads untrusted
 * pages must not be able to call it.
 */
export const DANGEROUS_TOOLS = Object.freeze([
  'mcp__playwright-test__browser_run_code_unsafe',
]);

/**
 * `tools: null` means the definition names no tools, so the agent inherits
 * every tool of the session, dangerous ones included.
 * @typedef {{ file: string, name: string, tools: string[] | null, body: string }} AgentDefinition
 * @typedef {{ permissions?: { deny?: string[] } }} Settings
 */

/**
 * Parse one generated agent file: its name, its tools (a comma-separated or
 * YAML-list `tools:` field) and the instructions after the front matter.
 * @param {string} file
 * @param {string} text
 * @returns {AgentDefinition}
 */
export function parseAgentDefinition(file, text) {
  const clean = text.replace(/^﻿/, '');
  const front = clean.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const head = front ? front[1] : '';
  const body = front ? front[2] : clean;
  const name = head.match(/^name:\s*(.+)$/m)?.[1].trim() ?? file;
  const field = head.match(/^tools:[ \t]*(.*)$/m);
  /** @type {string[] | null} */
  let tools = null;
  if (field) {
    const inline = field[1].trim();
    const list = inline
      ? inline.replace(/^\[|\]$/g, '').split(',')
      : (
          head
            .slice(head.indexOf(field[0]) + field[0].length)
            .match(/^(?:\r?\n[ \t]+-[ \t]*.+)+/)?.[0] ?? ''
        )
          .split(/\r?\n/)
          .map((l) => l.replace(/^[ \t]+-[ \t]*/, ''));
    tools = list
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return { file, name, tools, body };
}

/**
 * Whether a deny rule removes this tool: an exact name, `*`, `mcp__*`, a
 * bare `mcp__<server>` (every tool of that server) or a `mcp__<server>__*`
 * glob.
 * @param {string} tool
 * @param {string[]} deny
 */
export function isDenied(tool, deny) {
  return deny.some((rule) => {
    if (rule === tool || rule === '*' || rule === 'mcp__*') return true;
    if (rule.includes('(')) return false;
    if (/^mcp__[^_*]+(?:-[^_*]+)*$/.test(rule))
      return tool.startsWith(`${rule}__`);
    if (!rule.endsWith('*')) return false;
    return tool.startsWith(rule.slice(0, -1));
  });
}

/**
 * What is wrong (problems) and what deserves a look (warnings).
 * @param {AgentDefinition[]} agents
 * @param {Settings | null} settings
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function agentDefinitionProblems(agents, settings) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const deny = settings?.permissions?.deny ?? [];
  for (const agent of agents) {
    // No tools field: the agent inherits every tool, dangerous ones included.
    const granted = agent.tools ?? DANGEROUS_TOOLS;
    for (const tool of granted) {
      if (DANGEROUS_TOOLS.includes(tool) && !isDenied(tool, deny)) {
        const how = agent.tools
          ? 'is granted'
          : 'names no tools, so it inherits';
        problems.push(
          `${agent.file}: ${agent.name} ${how} ${tool}, which runs arbitrary code, and .claude/settings.json does not deny it`
        );
      }
    }
    if (
      /heal/i.test(agent.name) &&
      /fix(ing)?\s+assertions|expected values/i.test(agent.body)
    ) {
      warnings.push(
        `${agent.file}: the generated healer's own instructions allow fixing assertions or expected values; ` +
          'always start it with the invocation in docs/native-healer-handoff.md, which overrides that'
      );
    }
  }
  return { problems, warnings };
}
