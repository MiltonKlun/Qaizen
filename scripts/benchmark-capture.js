#!/usr/bin/env node
// @ts-check
// Benchmark capture (IMPROVEMENT-PLAN Phase 5, IP-5.3). Appends ONE
// measurement record (one story x one arm) to evidence/benchmark.jsonl after
// validating it against schemas/benchmark-record.schema.json via the single
// generic validator — a malformed measurement never lands in the file
// (discipline rule 3: validate before saving).
//
// This script records data a HUMAN measured while running the two arms of the
// benchmark (docs/benchmark-protocol.md). It does not run tests, time
// anything, or judge corrections itself — it is the honest write path for
// numbers the operator supplies. Unset metrics are stored as null (an explicit
// gap), never coerced to 0.
//
// Records are schema 1.1 (task group 9.2): every new record carries its
// provenance and keeps three timings apart. The app, operator and tools are
// supplied by the operator; the pipeline arm's prompt versions are READ from
// its run's context.json; the runtime is read from this machine; the
// measurement-method version is fixed below. A timing that was not recorded
// stays null — nothing is estimated, and no provider statistic is invented.
//
// Usage:
//   npm run benchmark:capture -- --story <id> --arm <raw|pipeline> \
//     --operator <who> --app <name@version> --tool <name@version> [flags]
//
// Required: --story, --arm, --operator, --app, at least one --tool (or
//   --model), and for the pipeline arm --context <run's context.json>
// Provenance: --app-commit <sha> --series <id> --model <id> (also a tool)
// Timing (omit => null): --wall-clock-min <n> --gate-review-min <n>
//   --agent-time-min <n>
// Optional metric flags (omit => null):
//   --time-to-green <min>        time_to_first_green_test_min
//   --gate4-corrections <n>      gate4_corrections
//   --fictional-rate <0..1>      fictional_test_rate
//   --selector-survival <0..1>   selector_survival_rate
//   --known-bug-catch <0..1>     known_bug_catch_rate
//   --traceability <0..1>        traceability_coverage
// Optional metadata: --track <lite|standard|full> --note "<free text>"
// Other:
//   --dry-run   validate + print the record; do not append
//
// Exit codes: 0 ok · 1 record failed validation · 2 usage error

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { platform, release, tmpdir } from 'node:os';
import { argv, exit, version as nodeVersion } from 'node:process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);
const VALIDATOR = join(SCRIPT_DIR, 'validate-json.js');
const SCHEMA = join(REPO, 'schemas', 'benchmark-record.schema.json');
const OUT = join(REPO, 'evidence', 'benchmark.jsonl');

const DRY = argv.includes('--dry-run');

/** How this record was measured; bump with docs/benchmark-protocol.md. */
const MEASUREMENT = {
  protocol_version: '2.0',
  selector_survival_method: 'probe-baseline-v1',
};

// Tiny flag parser: --key value (value-less flags handled explicitly above).
// Single-token: metadata (--model, --operator, --track) and numeric metrics.
/**
 * @param {string} name
 * @returns {string | undefined}
 */
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : undefined;
}

// Multi-word reader for free-text flags (--note): join every token after the
// flag up to the next `--flag`, so unquoted/shell-split multi-word values are
// not truncated to their first word. Returns undefined if the flag is absent
// or has no value tokens.
/**
 * @param {string} name
 * @returns {string | undefined}
 */
function textFlag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  /** @type {string[]} */
  const parts = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
    parts.push(argv[j]);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * @param {string} message
 * @returns {never}
 */
function usage(message) {
  console.error(
    `Error: ${message}\n` +
      'Usage: npm run benchmark:capture -- --story <id> --arm <raw|pipeline> --operator <who> ' +
      '--app <name@version> --tool <name@version> [--context <context.json>] [flags]\n' +
      'See the header of scripts/benchmark-capture.js for all flags.'
  );
  exit(2);
}

/**
 * Every value of a repeatable flag.
 * @param {string} name
 */
function flags(name) {
  /** @type {string[]} */
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--'))
      out.push(argv[i + 1]);
  }
  return out;
}

/**
 * `name@version` -> { name, version }.
 * @param {string} v
 * @param {string} what
 */
function nameAtVersion(v, what) {
  const i = v.lastIndexOf('@');
  if (i <= 0 || i === v.length - 1)
    usage(`${what} must be <name>@<version> (got "${v}")`);
  return { name: v.slice(0, i), version: v.slice(i + 1) };
}

const story = flag('story');
const arm = flag('arm');
if (!story || !arm) usage('--story and --arm are required');
if (arm !== 'raw' && arm !== 'pipeline') {
  usage(`--arm must be "raw" or "pipeline" (got "${arm}")`);
}
const operator = flag('operator');
if (!operator) usage('--operator is required: who ran this arm');
const appSpec = flag('app');
if (!appSpec)
  usage('--app <name@version> is required: the app measured against');
const app = nameAtVersion(appSpec, '--app');
const tools = flags('tool').map((t) => nameAtVersion(t, '--tool'));
const model = flag('model');
if (model) tools.push({ name: 'model', version: model });
if (tools.length === 0) {
  usage('at least one --tool <name@version> (or --model <id>) is required');
}

// The pipeline arm's prompt versions come from its run, never from memory.
let promptVersions = null;
if (arm === 'pipeline') {
  const ctxPath = flag('context');
  if (!ctxPath)
    usage("--context <run's context.json> is required for the pipeline arm");
  let ctx;
  try {
    ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
  } catch {
    usage(`--context ${ctxPath} is not a readable context.json`);
  }
  const pv = ctx.prompt_versions;
  if (!pv || typeof pv !== 'object' || Object.keys(pv).length === 0) {
    usage(
      `${ctxPath} records no prompt_versions; this run cannot be attributed to its prompts ` +
        '(docs/prompt-versioning.md)'
    );
  }
  promptVersions = pv;
}

/** The installed Playwright version, or null when it cannot be read. */
function playwrightVersion() {
  try {
    return JSON.parse(
      readFileSync(
        join(REPO, 'node_modules', '@playwright', 'test', 'package.json'),
        'utf8'
      )
    ).version;
  } catch {
    return null;
  }
}

// A metric flag becomes a number, or null when omitted (an explicit gap).
const num = (/** @type {string} */ name) => {
  const v = flag(name);
  if (v === undefined) return null;
  const n = Number(v);
  if (Number.isNaN(n)) {
    console.error(`--${name} must be a number (got "${v}").`);
    exit(2);
  }
  return n;
};

const record = {
  schema_version: '1.1',
  story_id: story,
  arm,
  recorded_at: new Date().toISOString(),
  ...(flag('model') ? { model: flag('model') } : {}),
  operator,
  ...(flag('track') ? { track: flag('track') } : {}),
  ...(flag('series') ? { series_id: flag('series') } : {}),
  provenance: {
    app: { ...app, commit: flag('app-commit') ?? null },
    prompt_versions: promptVersions,
    tools,
    runtime: {
      os: `${platform()} ${release()}`,
      node: nodeVersion,
      playwright: playwrightVersion(),
    },
    measurement: MEASUREMENT,
  },
  timing: {
    wall_clock_min: num('wall-clock-min'),
    gate_review_min: num('gate-review-min'),
    agent_tool_min: num('agent-time-min'),
  },
  metrics: {
    time_to_first_green_test_min: num('time-to-green'),
    gate4_corrections: num('gate4-corrections'),
    fictional_test_rate: num('fictional-rate'),
    selector_survival_rate: num('selector-survival'),
    known_bug_catch_rate: num('known-bug-catch'),
    traceability_coverage: num('traceability'),
  },
  notes: textFlag('note') ?? null,
};

// Validate via the single generic validator against the schema.
const tmp = join(tmpdir(), `benchmark-record-${Date.now()}.json`);
writeFileSync(tmp, JSON.stringify(record, null, 2));
try {
  const r = spawnSync(process.execPath, [VALIDATOR, SCHEMA, tmp], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('Record failed schema validation; nothing appended:');
    console.error((r.stdout || '') + (r.stderr || ''));
    exit(1);
  }
} finally {
  rmSync(tmp, { force: true });
}

if (DRY) {
  console.log('DRY RUN — record is valid; not appended:\n');
  console.log(JSON.stringify(record));
  exit(0);
}

// Append one compact JSON line (JSONL). Create evidence/ if needed.
mkdirSync(dirname(OUT), { recursive: true });
const line = JSON.stringify(record) + '\n';
if (existsSync(OUT)) appendFileSync(OUT, line);
else writeFileSync(OUT, line);

const count = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).length;
console.log(
  `Appended ${arm} record for ${story} to evidence/benchmark.jsonl (${count} record(s) total).`
);
exit(0);
