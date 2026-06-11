#!/usr/bin/env node
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
// Usage:
//   npm run benchmark:capture -- --story <id> --arm <raw|pipeline> [flags]
//
// Required: --story, --arm
// Optional metric flags (omit => null):
//   --time-to-green <min>        time_to_first_green_test_min
//   --gate4-corrections <n>      gate4_corrections
//   --fictional-rate <0..1>      fictional_test_rate
//   --selector-survival <0..1>   selector_survival_rate
//   --known-bug-catch <0..1>     known_bug_catch_rate
//   --traceability <0..1>        traceability_coverage
// Optional metadata: --model <id> --operator <who> --track <lite|standard|full>
//   --note "<free text>"
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
import { tmpdir } from 'node:os';
import { argv, exit } from 'node:process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);
const VALIDATOR = join(SCRIPT_DIR, 'validate-json.js');
const SCHEMA = join(REPO, 'schemas', 'benchmark-record.schema.json');
const OUT = join(REPO, 'evidence', 'benchmark.jsonl');

const DRY = argv.includes('--dry-run');

// Tiny flag parser: --key value (value-less flags handled explicitly above).
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : undefined;
}

const story = flag('story');
const arm = flag('arm');
if (!story || !arm) {
  console.error(
    'Usage: npm run benchmark:capture -- --story <id> --arm <raw|pipeline> [metric flags]\n' +
      'See the header of scripts/benchmark-capture.js for all flags.'
  );
  exit(2);
}
if (arm !== 'raw' && arm !== 'pipeline') {
  console.error(`--arm must be "raw" or "pipeline" (got "${arm}").`);
  exit(2);
}

// A metric flag becomes a number, or null when omitted (an explicit gap).
const num = (name) => {
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
  schema_version: '1.0',
  story_id: story,
  arm,
  recorded_at: new Date().toISOString(),
  ...(flag('model') ? { model: flag('model') } : {}),
  operator: flag('operator') ?? null,
  ...(flag('track') ? { track: flag('track') } : {}),
  metrics: {
    time_to_first_green_test_min: num('time-to-green'),
    gate4_corrections: num('gate4-corrections'),
    fictional_test_rate: num('fictional-rate'),
    selector_survival_rate: num('selector-survival'),
    known_bug_catch_rate: num('known-bug-catch'),
    traceability_coverage: num('traceability'),
  },
  notes: flag('note') ?? null,
};

// Validate via the single generic validator against the schema.
const tmp = join(tmpdir(), `benchmark-record-${Date.now()}.json`);
writeFileSync(tmp, JSON.stringify(record, null, 2));
try {
  const r = spawnSync('node', [VALIDATOR, SCHEMA, tmp], { encoding: 'utf8' });
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
