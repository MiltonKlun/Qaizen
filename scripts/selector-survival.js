#!/usr/bin/env node
// @ts-check
// Selector survival (IMPROVEMENT-PLAN Phase 5, IP-5.5; rebuilt in task group
// 9.1, review finding I7). Measures whether the locators a test relies on
// still identify their intended element after the app moved on — the "did
// these tests rot?" signal that separates tests written against a running app
// from tests guessed from text.
//
// Two modes:
//
//   --tests <file>   SOURCE INSPECTION, never a rate. Lists every locator
//                    chain as written (method, arguments, options, regex
//                    literals, scope) using the TypeScript parser, and marks
//                    the ones that are not static expressions as unmeasurable
//                    with the reason. Rebuilding a locator from text used to
//                    drop a role's accessible name and turn named locators into
//                    getByText, so survival was measured on the wrong locators.
//
//   --probe <module> MEASUREMENT. Runs reviewed probe functions (the exact
//                    locators, plus the preparation they need) on a named
//                    baseline and on each later app version. See
//                    scripts/lib/selector-probes.js for the probe contract and
//                    the survival rule, and examples/selector-probes/ for a
//                    reviewed example.
//
// ENVIRONMENT-DEPENDENT, and honest about it: without two distinct app
// versions, a working setup and probes that resolve on the baseline, it
// reports no rate and says why, so docs/evidence.md records the limitation
// rather than a fabricated number.
//
// Usage:
//   node scripts/selector-survival.js --tests tests/foo.spec.ts
//   node scripts/selector-survival.js --probe examples/selector-probes/demo-shop.probe.mjs \
//     --baseline v1=http://127.0.0.1:4001/ --version v2=http://127.0.0.1:4002/ \
//     [--version v3=<url> ...] [--out survival.json]
//
// Exit codes: 0 measured · 2 usage error, unreadable source/module, or no
//   locators · 3 no rate (source inspection only, or not measurable — an
//   honest gap, not a failure)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

import { extractLocators } from './lib/locator-source.js';
import {
  probeModuleProblems,
  runProbes,
  survivalResult,
} from './lib/selector-probes.js';

/**
 * @typedef {import('./lib/selector-probes.js').VersionEvidence} VersionEvidence
 */

/** @param {string} name */
function flags(name) {
  /** @type {string[]} */
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) out.push(argv[i + 1]);
  }
  return out;
}
/** @type {(name: string) => string | undefined} */
const flag = (name) => flags(name)[0];

/**
 * @param {string} [message]
 * @returns {never}
 */
function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(
    'Usage: node scripts/selector-survival.js --tests <file>\n' +
      '       node scripts/selector-survival.js --probe <module> --baseline <name>=<url> ' +
      '--version <name>=<url> [--version ...] [--out <file>]'
  );
  exit(2);
}

const testArg = flag('tests');
const probeArg = flag('probe');
if (Boolean(testArg) === Boolean(probeArg)) {
  usage(
    'pass exactly one of --tests (source inspection) or --probe (measurement)'
  );
}

// ------------------------------------------------------ source inspection --
if (testArg) {
  if (!existsSync(testArg)) {
    usage(
      `test file not found: ${testArg} (pass one file; glob expansion is the caller's job)`
    );
  }
  const r = extractLocators(readFileSync(testArg, 'utf8'), testArg);
  if (!r.ok) usage(`${testArg}: ${r.reason}`);
  if (r.locators.length === 0) usage(`no locators found in ${testArg}`);
  const measurable = r.locators.filter((l) => l.measurable);
  console.log(`Locators in ${testArg} (source inspection):`);
  for (const l of r.locators) {
    console.log(
      `  ${l.id} line ${l.line}: ${l.expression}` +
        (l.measurable ? '' : `\n      unmeasurable: ${l.reason}`)
    );
  }
  console.log(
    `\n${measurable.length} static, ${r.locators.length - measurable.length} unmeasurable.`
  );
  console.log(
    'SOURCE INSPECTION ONLY: no survival rate. A rate is measured by running reviewed\n' +
      'probe functions against a baseline and later app versions (--probe); a locator\n' +
      'rebuilt from text is not the locator the test runs.' +
      (flags('version').length
        ? '\n--version is ignored here; pass the versions with --probe.'
        : '')
  );
  exit(3);
}

// ------------------------------------------------------------ measurement --
/** @type {(v: string | undefined, what: string) => { name: string, url: string }} */
const parseVersion = (v, what) => {
  const m = /^([A-Za-z0-9._-]+)=(\S+)$/.exec(v ?? '');
  if (!m) usage(`${what} must be <name>=<url> (got ${v ?? 'nothing'})`);
  return { name: m[1], url: m[2] };
};
if (flags('baseline').length !== 1)
  usage('pass exactly one --baseline <name>=<url>');
const baseline = parseVersion(flag('baseline'), '--baseline');
const later = flags('version').map((v) => parseVersion(v, '--version'));
const outPath = flag('out');

const all = [baseline, ...later];
const names = new Set(all.map((v) => v.name));
const urls = new Set(all.map((v) => v.url));
if (names.size !== all.length || urls.size !== all.length) {
  usage('every version needs a distinct name and a distinct URL');
}

// The mutual-exclusion check above leaves --probe set on this path.
const probePath = /** @type {string} */ (probeArg);
if (!existsSync(probePath)) usage(`probe module not found: ${probePath}`);
/** @type {any} the imported probe module, checked by probeModuleProblems */
let mod;
try {
  mod = await import(pathToFileURL(resolve(probePath)).href);
} catch (e) {
  usage(
    `probe module ${probeArg} failed to load: ${e instanceof Error ? e.message : e}`
  );
}
const problems = probeModuleProblems(mod);
if (problems.length) usage(`probe module ${probeArg}: ${problems.join('; ')}`);
/** @type {import('./lib/selector-probes.js').Probe[]} */
const probes = mod.probes;

/**
 * @param {ReturnType<typeof survivalResult>} result
 * @param {VersionEvidence[]} evidence
 * @returns {never}
 */
function report(result, evidence) {
  const doc = {
    probe_module: probeArg,
    baseline: baseline.name,
    later_versions: later.map((v) => v.name),
    ...result,
    evidence,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  if (result.selector_survival_rate === null) {
    console.log(`\nNOT MEASURABLE: ${result.reason}.`);
    console.log(
      'Record selector_survival_rate: null and this reason (docs/evidence.md); do not estimate it.'
    );
    exit(3);
  }
  console.log(
    `\nSurvival across ${later.length} later version(s): ${result.numerator}/${result.denominator} = ` +
      `${(result.selector_survival_rate * 100).toFixed(1)}%`
  );
  for (const id of result.lost) console.log(`  DID NOT survive: ${id}`);
  console.log(
    `\nselector_survival_rate for the benchmark record: ${result.selector_survival_rate.toFixed(3)}`
  );
  exit(0);
}

// Fewer than two distinct versions: no drift to measure, and no browser needed.
if (later.length === 0) {
  report(
    survivalResult(
      probes.map((p) => p.id),
      baseline,
      []
    ),
    []
  );
}

/** @type {import('@playwright/test').BrowserType} */
let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  usage('Playwright is required to run probes against live versions.');
}

const browser = await chromium.launch();
/** @type {(VersionEvidence & { url: string })[]} */
const evidence = [];
try {
  for (const v of all) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    /** @type {VersionEvidence & { url: string }} */
    const entry = { name: v.name, url: v.url };
    try {
      await mod.prepare(page, { baseURL: v.url });
      entry.results = await runProbes(page, probes);
    } catch (e) {
      entry.setup_error =
        e instanceof Error ? e.message.split('\n')[0] : String(e);
    } finally {
      await context.close();
    }
    evidence.push(entry);
    console.log(
      `${v === baseline ? 'baseline' : 'version'} ${v.name}: ` +
        (entry.setup_error
          ? `setup failed (${entry.setup_error})`
          : (entry.results ?? [])
              .map(
                (r) =>
                  `${r.probe}=${r.error ? 'error' : r.resolved ? 'ok' : `${r.count} target(s)`}`
              )
              .join(' '))
    );
  }
} finally {
  await browser.close();
}

report(
  survivalResult(
    probes.map((p) => p.id),
    evidence[0],
    evidence.slice(1)
  ),
  evidence
);
