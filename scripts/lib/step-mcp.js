// @ts-check
// Which MCP servers each agent step may use.
//
// A session that holds every server in .mcp.json can read untrusted text (a
// Jira ticket, a web page, an API response) while holding tools that reach
// other systems. Each agent step therefore runs in its own session with only
// the servers it needs, from a config under config/mcp/, started with
// --strict-mcp-config so no other MCP configuration is loaded. The runner never
// launches agents; it prints this command for the operator.
//
// Pure: no I/O.

/** The config each agent step runs with (config/mcp/<name>.json). */
export const STEP_MCP = Object.freeze({
  analyst: 'analyst', // atlassian (read-only) + github (read-only)
  'test-designer': 'none',
  planner: 'playwright',
  generator: 'playwright',
  healer: 'playwright',
  api: 'postman',
  'external-plan': 'none',
  finalize: 'none',
  report: 'none',
});

/** The servers each config holds; config/mcp/*.json must match. */
export const MCP_SETS = Object.freeze({
  analyst: ['atlassian', 'github'],
  playwright: ['playwright-test'],
  postman: ['postman'],
  none: [],
});

/**
 * The command that starts a session for this agent step with only its
 * servers, or null when the step is not an agent step.
 * @param {string} step
 * @returns {string | null}
 */
export function launchCommand(step) {
  const set = /** @type {Record<string, string>} */ (STEP_MCP)[step];
  if (!set) return null;
  return `claude --strict-mcp-config --mcp-config config/mcp/${set}.json`;
}

/**
 * The line the runner prints under an agent step's instruction. An unknown
 * step is a bug in the caller (a new agent step needs a mapping above), so it
 * throws instead of silently printing no command.
 * @param {string} step
 * @returns {string}
 */
export function launchLine(step) {
  const command = launchCommand(step);
  if (!command) throw new Error(`no MCP config is mapped for step "${step}"`);
  const set = /** @type {Record<string, string>} */ (STEP_MCP)[step];
  /** @type {readonly string[]} */
  const servers = /** @type {Record<string, readonly string[]>} */ (MCP_SETS)[
    set
  ];
  const what = servers.length
    ? `only its MCP servers (${servers.join(', ')})`
    : 'no MCP server';
  return `  Start a fresh session with ${what}:\n    ${command}\n`;
}
