#!/usr/bin/env node
// @ts-check
// Record what happened after a run: a defect it should have caught, or what
// it cost. A person runs this; no agent does. It writes only under outcomes/
// (scripts/lib/outcomes.js) and never changes the archived run it names.
//
//   escaped-defect   a product bug a completed run should have caught, found
//                    later; linked to the run and to the risks of that run it
//                    falls under. It feeds the defect history and the metrics.
//   cost             the hands-on time and the spend of one run, which the
//                    pipeline cannot measure.
//   outside-review   an outside reviewer's verdict on a full-track approval
//                    the sampled outside review marked
//                    (docs/review-gates.md, "Independence at Gates 2 and 4").
//
// Usage:
//   npm run record-outcome -- escaped-defect --story <id> --run <run> \
//     (--risk RISK-001 [--risk ...] | --unresolved "<why no risk covers it>") \
//     [--case TC-002 ...] --summary "<what went wrong>" \
//     --severity high|medium|low --found-in production|staging|later_run|other \
//     --found-at YYYY-MM-DD \
//     --why-missed no_case|not_automated|test_passed_wrongly|not_run|unknown \
//     --by "<who records it>" [--jira ABC-123] [--notes "..."] //     [--replace ESC-NNN | --force-new] [--dry-run]
//   npm run record-outcome -- cost --story <id> --run <run> \
//     [--minutes 95] [--spend 3.40 --currency USD] --by "<who>" \
//     [--notes "..."] [--replace] [--dry-run]
//   npm run record-outcome -- outside-review --story <id> --run <run> \
//     --gate gate2|gate4|gate4-api [--decided-at <ISO time>] \
//     --verdict agree|disagree --by "<outside reviewer>" [--notes "..."] \
//     [--replace] [--dry-run]
//
// --run is the archive folder under runs/<story>/ or the run id its context
// records. A defect already recorded (same Jira key, or same run and summary)
// is refused: --replace ESC-NNN rewrites that record under its id, once more is
// known; --force-new records another defect that only looks the same. Nothing is written to Jira; --jira only notes a ticket a person
// filed.
//
// Exit codes: 0 recorded (or printed with --dry-run) · 2 usage error or
//             refusal (nothing written)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

import { formatErrors, readJson, writeJsonAtomic } from './lib/artifact-io.js';
import { parseCli, validateStoryId } from './lib/cli.js';
import {
  COSTS_DIR,
  ESCAPED_DEFECT_SCHEMA,
  ESCAPED_DIR,
  OUTSIDE_DIR,
  OUTSIDE_REVIEW_SCHEMA,
  STORY_COST_SCHEMA,
  buildEscapedDefect,
  buildOutsideReview,
  findArchivedRun,
  nextEscapedId,
  readEscapedDefects,
  withCostEntry,
  withOutsideReview,
} from './lib/outcomes.js';

const USAGE = [
  'Usage:',
  '  node scripts/record-outcome.js escaped-defect --story <id> --run <run> (--risk RISK-NNN ... | --unresolved "<why>") [--case TC-NNN ...] --summary "<text>" --severity high|medium|low --found-in production|staging|later_run|other --found-at YYYY-MM-DD --why-missed no_case|not_automated|test_passed_wrongly|not_run|unknown --by "<name>" [--jira KEY-1] [--notes "<text>"] [--replace ESC-NNN | --force-new] [--dry-run]',
  '  node scripts/record-outcome.js cost --story <id> --run <run> [--minutes <n>] [--spend <amount> --currency <ISO 4217>] --by "<name>" [--notes "<text>"] [--replace] [--dry-run]',
  '  node scripts/record-outcome.js outside-review --story <id> --run <run> --gate gate2|gate4|gate4-api [--decided-at <ISO time>] --verdict agree|disagree --by "<outside reviewer>" [--notes "<text>"] [--replace] [--dry-run]',
].join('\n');
const RUNS = 'runs';

/**
 * @param {string[]} lines
 * @returns {never}
 */
function refuse(lines) {
  console.error('Refused; nothing written:');
  for (const l of lines) console.error(`  - ${l}`);
  exit(2);
}

/**
 * @param {string} message
 * @returns {never}
 */
function usage(message) {
  console.error(`Error: ${message}`);
  console.error(USAGE);
  exit(2);
}

const common = {
  story: /** @type {const} */ ({ type: 'string' }),
  run: /** @type {const} */ ({ type: 'string' }),
  by: /** @type {const} */ ({ type: 'string' }),
  notes: /** @type {const} */ ({ type: 'string' }),
  'dry-run': /** @type {const} */ ({ type: 'boolean' }),
};

const [kind, ...rest] = argv.slice(2);
if (kind !== 'escaped-defect' && kind !== 'cost' && kind !== 'outside-review')
  usage(
    `the first argument is escaped-defect, cost or outside-review (got "${kind ?? ''}")`
  );

const cli = parseCli(
  rest,
  kind === 'escaped-defect'
    ? {
        usage: USAGE,
        options: {
          ...common,
          risk: { type: 'string', multiple: true },
          unresolved: { type: 'string' },
          case: { type: 'string', multiple: true },
          summary: { type: 'string' },
          severity: { type: 'string', choices: ['high', 'medium', 'low'] },
          'found-in': {
            type: 'string',
            choices: ['production', 'staging', 'later_run', 'other'],
          },
          'found-at': { type: 'string' },
          'why-missed': {
            type: 'string',
            choices: [
              'no_case',
              'not_automated',
              'test_passed_wrongly',
              'not_run',
              'unknown',
            ],
          },
          jira: { type: 'string' },
          replace: { type: 'string' },
          'force-new': { type: 'boolean' },
        },
        exclusive: [
          ['risk', 'unresolved'],
          ['replace', 'force-new'],
        ],
      }
    : kind === 'outside-review'
      ? {
          usage: USAGE,
          options: {
            ...common,
            gate: { type: 'string' },
            'decided-at': { type: 'string' },
            verdict: { type: 'string', choices: ['agree', 'disagree'] },
            replace: { type: 'boolean' },
          },
        }
      : {
          usage: USAGE,
          options: {
            ...common,
            minutes: { type: 'string' },
            spend: { type: 'string' },
            currency: { type: 'string' },
            replace: { type: 'boolean' },
          },
        }
);
if (!cli.ok) usage(cli.error);
const v = /** @type {Record<string, any>} */ (cli.values);

const required =
  kind === 'escaped-defect'
    ? [
        'story',
        'run',
        'summary',
        'severity',
        'found-in',
        'found-at',
        'why-missed',
        'by',
      ]
    : kind === 'outside-review'
      ? ['story', 'run', 'gate', 'verdict', 'by']
      : ['story', 'run', 'by'];
// Text that is only spaces is not given.
for (const k of Object.keys(v))
  if (typeof v[k] === 'string') v[k] = v[k].trim();
const missing = required.filter((k) => v[k] === undefined || v[k] === '');
if (missing.length) usage(`missing ${missing.map((k) => `--${k}`).join(', ')}`);
const storyProblem = validateStoryId(v.story);
if (storyProblem) usage(storyProblem);

const found = findArchivedRun(RUNS, v.story, v.run);
if (!found.ok) refuse([found.error]);
const run = found.run;
const now = new Date();

/**
 * Write a validated record, or print it on a dry run.
 * @param {string} path
 * @param {any} value
 * @param {string} schema
 * @param {string} done
 */
function save(path, value, schema, done) {
  if (v['dry-run']) {
    console.log(JSON.stringify(value, null, 2));
    console.log(`\nDRY RUN: ${path} not written.`);
    exit(0);
  }
  const w = writeJsonAtomic(path, value, { schemaPath: schema, root: '.' });
  if (!w.ok)
    refuse([
      w.message,
      ...formatErrors(/** @type {any} */ (w).errors).map((l) => l.trim()),
    ]);
  console.log(done);
}

if (kind === 'escaped-defect') {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v['found-at']) ||
    Number.isNaN(Date.parse(v['found-at']))
  )
    usage(`--found-at expects a date as YYYY-MM-DD (got "${v['found-at']}")`);
  // Compared as dates on this machine's calendar: today is never "future",
  // whatever the time zone.
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  if (v['found-at'] > today)
    refuse([`--found-at ${v['found-at']} is after today (${today})`]);
  const existing = readEscapedDefects(ESCAPED_DIR).records;
  if (v.replace !== undefined) {
    const old = existing.find((r) => r.escaped_defect_id === v.replace);
    if (!old)
      refuse([
        `--replace ${v.replace}: no valid record of that id under ${ESCAPED_DIR}/`,
      ]);
    if (old.story_id !== v.story)
      refuse([
        `--replace ${v.replace}: it records a defect of ${old.story_id}, not ${v.story}`,
      ]);
  }
  const id = v.replace ?? nextEscapedId(ESCAPED_DIR);
  const built = buildEscapedDefect({
    id,
    story: v.story,
    run,
    risks: v.risk ?? [],
    unresolved: v.unresolved,
    cases: v.case ?? [],
    summary: v.summary,
    severity: v.severity,
    foundIn: v['found-in'],
    foundAt: v['found-at'],
    whyMissed: v['why-missed'],
    jira: v.jira,
    notes: v.notes,
    by: v.by,
    now,
    existing,
    forceNew: v['force-new'] === true,
  });
  if (!built.ok) refuse(built.errors);
  else
    save(
      join(ESCAPED_DIR, `${id}.json`),
      built.record,
      ESCAPED_DEFECT_SCHEMA,
      `${v.replace ? 'Replaced' : 'Recorded'} ${id}: ${v.story} (${run.runId}) let a ${v.severity} defect escape (${v['why-missed']}). Regenerate the defect history (npm run defect-history) and the metrics (npm run metrics) to include it.`
    );
} else if (kind === 'outside-review') {
  const built = buildOutsideReview({
    run,
    gate: v.gate,
    decidedAt: v['decided-at'],
    verdict: v.verdict,
    notes: v.notes,
    by: v.by,
    now,
  });
  if (!built.ok) refuse(built.errors);
  const path = join(OUTSIDE_DIR, `${v.story}.json`);
  /** @type {any} */
  let doc = null;
  if (existsSync(path)) {
    const r = readJson(path);
    if (!r.ok) refuse([r.message]);
    else doc = r.data;
    if (doc?.story_id !== v.story)
      refuse([`${path} is not ${v.story}'s outside-review record`]);
  }
  const entry = /** @type {{ ok: true, entry: any }} */ (built).entry;
  const next = withOutsideReview(doc, v.story, entry, v.replace === true);
  if (!next.ok) refuse(next.errors);
  else
    save(
      path,
      next.doc,
      OUTSIDE_REVIEW_SCHEMA,
      `Recorded ${v.by}'s outside review of ${entry.gate} in ${v.story} (${run.runId}, decided ${entry.decided_at}): ${entry.verdict}.${entry.verdict === 'disagree' ? ' Follow it up: reopen the gate, or record an escaped defect.' : ''} npm run metrics counts it.`
    );
} else {
  /** @param {string} flag */
  const number = (flag) => {
    if (v[flag] === undefined) return undefined;
    const n = Number(v[flag]);
    if (!/^\d+(\.\d+)?$/.test(v[flag]) || !Number.isFinite(n))
      usage(`--${flag} expects a non-negative number (got "${v[flag]}")`);
    return n;
  };
  const minutes = number('minutes');
  const spend = number('spend');
  if (minutes === undefined && spend === undefined)
    usage('give --minutes, --spend, or both');
  if ((spend === undefined) !== (v.currency === undefined))
    usage('--spend and --currency go together');
  if (v.currency !== undefined && !/^[A-Z]{3}$/.test(v.currency))
    usage(
      `--currency expects an ISO 4217 code such as USD (got "${v.currency}")`
    );
  const path = join(COSTS_DIR, `${v.story}.json`);
  /** @type {any} */
  let doc = null;
  if (existsSync(path)) {
    const r = readJson(path);
    if (!r.ok) refuse([r.message]);
    else doc = r.data;
    if (doc?.story_id !== v.story)
      refuse([`${path} is not ${v.story}'s cost record`]);
  }
  const next = withCostEntry(
    doc,
    v.story,
    {
      run_id: run.runId,
      run_archive: run.archive,
      ...(minutes !== undefined ? { operator_minutes: minutes } : {}),
      ...(spend !== undefined
        ? { spend: { amount: spend, currency: v.currency } }
        : {}),
      ...(v.notes ? { notes: v.notes } : {}),
      recorded_at: now.toISOString(),
      recorded_by: v.by,
    },
    v.replace === true
  );
  if (!next.ok) refuse(next.errors);
  else
    save(
      path,
      next.doc,
      STORY_COST_SCHEMA,
      `Recorded the cost of ${v.story} (${run.runId}) in ${path}.`
    );
}
