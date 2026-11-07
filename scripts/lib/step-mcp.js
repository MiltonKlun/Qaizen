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

/**
 * The way out, said with every step whose agent may find its task cannot be
 * done within the rules: a stop is a correct outcome, a workaround is not.
 * The native agents' prompts are generated and never edited, so the operator
 * passes the quoted sentence on with the step.
 */
export const IMPOSSIBLE_LINE =
  '  Tell it, word for word: "If this cannot be done within the rules (the app or\n' +
  '  the endpoint does not do what the spec or the cases describe, or a step cannot\n' +
  '  be performed), write nothing, reply IMPOSSIBLE: <why> and stop."\n' +
  '  After an IMPOSSIBLE, decide with the scope owner: fix the spec, the scope or\n' +
  '  the story, or, when the app is what is wrong, raise a defect. Never change the\n' +
  '  expected behavior to match the app. Resume once that is done.\n';
