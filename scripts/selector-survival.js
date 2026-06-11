#!/usr/bin/env node
// Selector survival (IMPROVEMENT-PLAN Phase 5, IP-5.5). Measures how many of a
// test file's locators STILL RESOLVE after the app moved on — the "did these
// tests rot?" signal that distinguishes tests written against a running app
// (the pipeline's rule-8 discipline) from tests guessed from text.
//
// It extracts locators from one or more Playwright spec files and checks each
// against >=2 later versions of the app (served at the URLs you pass). It
// reports a survival rate per file and overall, suitable for
// metrics.selector_survival_rate in a benchmark record.
//
// ENVIRONMENT-DEPENDENT, and honest about it: if you cannot point it at >=2
// later app versions, it does NOT invent a number. It exits with a clear
// "qualitative only" notice so docs/evidence.md records the limitation rather
// than a fabricated rate (the plan's explicit instruction).
//
// Usage:
//   node scripts/selector-survival.js --tests "<glob-or-file>" \
//     --version http://host:PORT_v2 --version http://host:PORT_v3
//   node scripts/selector-survival.js --tests tests/foo.spec.ts   # no versions
//     => prints the extracted locators + the qualitative-only notice, exit 3
//
// Locator extraction is intentionally simple and transparent: it pulls the
// string arguments of page.locator('...') and the names from getByRole/
// getByLabel/getByText/getByTestId/getByPlaceholder calls. It does not execute
// the test; it resolves each locator with Playwright against each version.
//
// Exit codes: 0 measured · 2 usage/no-locators · 3 no app versions (qualitative
//   only — not a failure, an honest gap)

import { readFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

function flags(name) {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}
function flag(name) {
  return flags(name)[0];
}

const testArg = flag('tests');
const versions = flags('version');
if (!testArg) {
  console.error(
    'Usage: node scripts/selector-survival.js --tests <file> [--version <url> --version <url> ...]'
  );
  exit(2);
}
if (!existsSync(testArg)) {
  console.error(
    `Test file not found: ${testArg} (glob expansion is the caller's job; pass one file).`
  );
  exit(2);
}

// --- transparent locator extraction --------------------------------------
// CSS / text passed to page.locator('...') or expect(page.locator('...')).
const source = readFileSync(testArg, 'utf8');
const locators = [];
const seen = new Set();
const add = (kind, value) => {
  const key = `${kind}:${value}`;
  if (!seen.has(key)) {
    seen.add(key);
    locators.push({ kind, value });
  }
};

// Match the OUTER quote and capture everything up to the same closing quote,
// so an inner quote (page.locator('[data-test="x"]')) is preserved.
for (const m of source.matchAll(/\.locator\(\s*(['"`])((?:(?!\1).)*)\1/g)) {
  add('css', m[2]);
}
for (const m of source.matchAll(
  /\.getBy(Role|Label|Text|TestId|Placeholder|Title|AltText)\(\s*(['"`])((?:(?!\2).)*)\2/g
)) {
  add(`getBy${m[1]}`, m[3]);
}

if (locators.length === 0) {
  console.error(
    `No locators extracted from ${testArg}. (Looked for page.locator('...') and getBy* string args.)`
  );
  exit(2);
}

console.log(`Extracted ${locators.length} locator(s) from ${testArg}:`);
for (const l of locators) console.log(`  [${l.kind}] ${l.value}`);

// --- no versions => qualitative-only, honest gap --------------------------
if (versions.length < 2) {
  console.log('');
  console.log(
    'QUALITATIVE ONLY: fewer than 2 later app versions were provided, so a\n' +
      'survival RATE cannot be measured without fabricating it. Record this as\n' +
      'a null selector_survival_rate in the benchmark and explain in\n' +
      'docs/evidence.md why app history was unavailable (the plan forbids\n' +
      'faking the number). To measure: serve >=2 later app versions and pass\n' +
      'each with --version <url>.'
  );
  exit(3);
}

// --- measure survival against each version --------------------------------
// Resolve each locator with Playwright against each version; a locator
// "survives" a version if it matches >=1 element there.
async function measure() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'Playwright is required to resolve locators against live versions.'
    );
    exit(2);
  }
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const l of locators) {
      let survivedAll = true;
      for (const url of versions) {
        const page = await browser.newPage();
        let matched = 0;
        try {
          await page.goto(url, { timeout: 10000, waitUntil: 'load' });
          const loc =
            l.kind === 'css'
              ? page.locator(l.value)
              : l.kind === 'getByTestId'
                ? page.getByTestId(l.value)
                : l.kind === 'getByRole'
                  ? page.getByRole(l.value)
                  : page.getByText(l.value); // best-effort for name-based
          matched = await loc.count();
        } catch {
          matched = 0;
        } finally {
          await page.close();
        }
        if (matched === 0) survivedAll = false;
      }
      results.push({ locator: l, survived: survivedAll });
    }
  } finally {
    await browser.close();
  }
  const survived = results.filter((r) => r.survived).length;
  const rate = survived / results.length;
  console.log('');
  console.log(
    `Survival across ${versions.length} version(s): ${survived}/${results.length} = ${(rate * 100).toFixed(0)}%`
  );
  for (const r of results) {
    if (!r.survived)
      console.log(`  DID NOT survive: [${r.locator.kind}] ${r.locator.value}`);
  }
  console.log(
    `\nselector_survival_rate for the benchmark record: ${rate.toFixed(3)}`
  );
  exit(0);
}

measure();
