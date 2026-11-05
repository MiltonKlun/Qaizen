#!/usr/bin/env node
// @ts-check
// Pre-Gate-4 static scan. Surfaces
// the MECHANICAL Gate-4 findings so the human reviewer spends judgment, not
// archaeology. It INFORMS and NEVER fixes: it does not edit files, does not
// decide the gate, and changes nothing about the approval bar. Gate 4 is
// always a human decision (CLAUDE.md §3.5) — this just hands the reviewer the
// checklist's mechanical half pre-answered so they can focus on the rest.
//
// gate4Findings(source, { fileName, artifacts }) ->
//   { findings: [{ rule, line, test, excerpt, note }],
//     traceability: { tests, verified, basis }, judgment: string[] }
// Pure: the caller reads files (loadGate4Artifacts does it for the CLI and
// the runner).
//
// Checks (all mechanical — a human still judges business correctness):
//   - hard waits: waitForTimeout and setTimeout, also through bracket
//     access, a bound alias, globalThis or a timers/promises import; never
//     in comments (docs/review-gates.md, Gate 4, lists what is followed)
//   - fragile locators: :nth-child, nth=, .first() / .last() / .nth(),
//     index XPath [n], long CSS chains
//   - test suppression: .skip / .fixme / .only / .fail, from the parsed test
//     registrations (aliases, bracket access, namespace imports and
//     destructured names resolved; comments ignored)
//   - weak assertions: toBeTruthy / toBeDefined / toBeFalsy / .not.toThrow
//     and comparisons nothing can fail; constant subjects
//   - weak oracles, per test (scripts/lib/oracle-checks.js): no assertion,
//     soft only, conditional or swallowed assertions, absence only, a value
//     its own mock served, expected values no approved case or criterion
//     states, retries, test.slow() and long timeouts
//   - coverage: with --context, approved E2E cases no scanned test names
//   - traceability, PER TEST: every generated
//     test needs its own PW, TC and SPEC id (docs/traceability.md). A file
//     header does not cover the tests below it. Missing, conflicting,
//     duplicate and unverifiable ids are reported with test and line.
//     With --context, TC and SPEC ids are checked against the run's approved
//     test cases and spec; without it the scan says the linkage is unverified.
//
// Usage:
//   node scripts/gate4-scan.js [--context context.json] <file> [<file> ...]
//   npm run scan:gate4 -- tests/STORY-1.spec.ts
//
// Exit codes: 0 scan ran, findings informational · 1 a full-track story
//   (--context, the higher of track and track_floor) has findings · 2 usage /
//   unreadable file or context. Without --context, or on the lite or standard track,
//   findings never fail the scan. Exit 1 blocks no gate and approves nothing:
//   the human still decides Gate 4.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

import { GATE4_JUDGMENT_QUESTIONS } from './gate-briefs.js';
import { effectiveTrack } from './track-floor.js';
import { oracleFindings, uncoveredCases } from './lib/oracle-checks.js';
import {
  TEST_ID_KINDS,
  parseTestSource,
  testIdentities,
  testRegistrations,
} from './lib/test-source.js';

/**
 * What a traceability check reads, from loadGate4Artifacts.
 * @typedef {{ contextPath: string, storyId: string | null, testCases: any,
 *   testCasesPath: string | null, specText: string | null,
 *   specPath: string | null, criteria?: string[] | null,
 *   track?: string }} Gate4Artifacts
 * @typedef {{ rule: string, line: number | null, test: string | null,
 *   excerpt: string, note: string }} Finding
 * @typedef {(rule: string, line: number | null, note: string,
 *   test?: string | null) => void} AddFinding
 * @typedef {{ test: string, line: number, ids: Record<string, string[]>,
 *   exempt: boolean }} TraceEntry
 * @typedef {{ tests: TraceEntry[], verified: string[], basis: string }} Traceability
 */

// Per-rule line matchers for what lives inside strings and calls.
/** @type {{ rule: string, note: string, test: (line: string) => boolean }[]} */
const LINE_RULES = [
  {
    rule: 'fragile_locator',
    note: 'fragile locator — nth-child / nth= / index XPath / long CSS chain; prefer a stable hook or role',
    test: (l) =>
      /:nth-child\(|\bnth=|\/\/[^'"`]*\[\d+\]/.test(l) ||
      // a CSS string with 3+ descendant combinators is a brittle chain
      /['"`][^'"`]*(?:\s+>?\s*[.#][\w-]+){3,}[^'"`]*['"`]/.test(l),
  },
];

/**
 * The seed test is the one documented non-business exception.
 * @param {string | undefined} fileName
 * @param {{ titlePath: string[] }} identity
 */
function isSeedTest(fileName, identity) {
  return (
    basename(fileName ?? '') === 'seed.spec.ts' &&
    identity.titlePath.length > 1 &&
    /^Seed:/.test(identity.titlePath[0])
  );
}

/**
 * Scan one test source.
 *
 * @param {string} source
 * @param {object} [opts]
 * @param {string} [opts.fileName]
 * @param {Gate4Artifacts | null} [opts.artifacts] from loadGate4Artifacts
 * @param {boolean} [opts.coverage] report approved E2E cases no test in this
 *   source names (the CLI turns it off per file and checks all files at once)
 * @returns {{ findings: Finding[], traceability: Traceability,
 *   judgment: string[] }}
 */
export function gate4Findings(
  source,
  { fileName = 'test.spec.ts', artifacts, coverage = true } = {}
) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = (source || '').split('\n');
  const excerptAt = (/** @type {number | null} */ line) =>
    line ? (lines[line - 1] ?? '').trim().slice(0, 100) : '(whole file)';
  /** @type {AddFinding} */
  const add = (rule, line, note, test = null) => {
    findings.push({ rule, line, test, excerpt: excerptAt(line), note });
  };

  lines.forEach((line, i) => {
    // A comment line describes code; it is not code.
    if (/^\s*(\/\/|\/?\*)/.test(line)) return;
    for (const r of LINE_RULES) if (r.test(line)) add(r.rule, i + 1, r.note);
  });

  const parsed = parseTestSource(source || '', fileName);
  if (!parsed.ok) {
    add(
      'unsupported_source',
      null,
      `${parsed.reason} — suppression, assertions and traceability were not checked`
    );
    return {
      findings,
      traceability: {
        tests: [],
        verified: [],
        basis: 'not checked: the source did not parse',
      },
      judgment: GATE4_JUDGMENT_QUESTIONS(),
    };
  }
  const sf = parsed.sourceFile;

  for (const r of testRegistrations(sf)) {
    if (r.suppression.length) {
      add(
        'test_suppression',
        r.line,
        `test suppression (.${r.suppression.join('/.')}) — a Gate-4 rejection unless documented`
      );
    }
  }

  oracleFindings(sf, { add, artifacts });

  const traceability = checkTraceability(sf, fileName, artifacts, add);
  if (coverage && artifacts?.testCases?.story_id === artifacts?.storyId) {
    for (const tc of uncoveredCases(
      artifacts?.testCases,
      namedCases(traceability)
    ))
      add(
        'uncovered_case',
        null,
        `${tc} is an approved E2E case of ${artifacts?.storyId}, but no test in this file names it`
      );
  }
  return { findings, traceability, judgment: GATE4_JUDGMENT_QUESTIONS() };
}

/**
 * Per-test identity checks; returns what was actually verified.
 * @param {import('./lib/test-source.js').ts.SourceFile} sf
 * @param {string} fileName
 * @param {Gate4Artifacts | null | undefined} artifacts
 * @param {AddFinding} add
 * @returns {Traceability}
 */
function checkTraceability(sf, fileName, artifacts, add) {
  const tests = testIdentities(sf);
  /** @type {Map<string, string>} */
  const pwSeen = new Map();
  /** @type {string[]} */
  const verified = [];

  /** @type {Map<string, { status?: string }> | null} */
  let cases = null;
  if (artifacts?.testCases) {
    if (artifacts.testCases.story_id !== artifacts.storyId) {
      add(
        'story_mismatch',
        null,
        `${artifacts.testCasesPath} is for story ${artifacts.testCases.story_id}, not the active ${artifacts.storyId}; TC links were not verified`
      );
    } else {
      cases = new Map(
        artifacts.testCases.test_cases.map(
          (/** @type {{ test_case_id: string, status?: string }} */ c) => [
            c.test_case_id,
            c,
          ]
        )
      );
      verified.push(
        `TC ids against ${artifacts.testCasesPath} (approved scope)`
      );
    }
  }
  /** @type {Set<string> | null} */
  let specIds = null;
  if (artifacts?.specText != null) {
    const declared = new Set(artifacts.specText.match(/\bSPEC-\d+\b/g) ?? []);
    if (declared.size) {
      specIds = declared;
      verified.push(`SPEC ids against ${artifacts.specPath}`);
    } else {
      add(
        'unverifiable_traceability',
        null,
        `${artifacts.specPath} declares no SPEC id, so the tests' SPEC references cannot be checked against it`
      );
    }
  }

  /** @type {TraceEntry[]} */
  const report = [];
  for (const t of tests) {
    const label = t.titlePath.join(' > ');
    /** @type {TraceEntry} */
    const entry = { test: label, line: t.line, ids: {}, exempt: false };
    report.push(entry);
    if (isSeedTest(fileName, t)) {
      entry.exempt = true; // documented non-business exception (seed)
      continue;
    }
    if (t.dynamic) {
      add(
        'unverifiable_traceability',
        t.line,
        'registered dynamically — its ids cannot be resolved statically; verify them by hand',
        label
      );
      continue;
    }
    /** @type {string[]} */
    const missing = [];
    for (const kind of TEST_ID_KINDS) {
      const src = t.ids[kind];
      const all = [
        ...new Set([...src.annotation, ...src.title, ...src.comment]),
      ];
      entry.ids[kind] = all;
      if (all.length === 0) missing.push(kind);
      const sources = [src.annotation, src.title, src.comment].filter(
        (s) => s.length
      );
      const disagree = sources.some(
        (s) => s.slice().sort().join() !== sources[0].slice().sort().join()
      );
      if ((kind === 'PW' && all.length > 1) || disagree) {
        add(
          'conflicting_traceability',
          t.line,
          `conflicting ${kind} ids for this test: ${all.join(', ')}`,
          label
        );
      }
    }
    if (missing.length) {
      add(
        'missing_traceability',
        t.line,
        `this test declares no ${missing.join(' / ')} id of its own — each test needs PW, TC and SPEC (docs/traceability.md)`,
        label
      );
    }
    for (const pw of entry.ids.PW ?? []) {
      if (pwSeen.has(pw)) {
        add(
          'duplicate_traceability',
          t.line,
          `${pw} is also claimed by "${pwSeen.get(pw)}" — each test needs its own PW id`,
          label
        );
      } else pwSeen.set(pw, label);
    }
    const tcs = entry.ids.TC ?? [];
    if (tcs.length && !t.ids.TC.title.length) {
      add(
        'unlinked_title',
        t.line,
        `${tcs.join(', ')} is not in the test title, so execution results cannot be linked to it (the ledger reads titles)`,
        label
      );
    }
    if (cases) {
      for (const tc of tcs) {
        const c = cases.get(tc);
        if (!c) {
          add(
            'unknown_reference',
            t.line,
            `${tc} is not a test case of ${artifacts?.storyId}`,
            label
          );
        } else if (c.status !== 'approved') {
          add(
            'unknown_reference',
            t.line,
            `${tc} is not approved (status ${c.status})`,
            label
          );
        }
      }
    }
    if (specIds) {
      for (const spec of entry.ids.SPEC ?? []) {
        if (!specIds.has(spec)) {
          add(
            'unknown_reference',
            t.line,
            `${spec} is not declared in ${artifacts?.specPath}`,
            label
          );
        }
      }
    }
  }
  if (tests.length)
    verified.push(
      'PW ids for presence and uniqueness only (no artifact defines them)'
    );

  return {
    tests: report,
    verified: artifacts ? verified : [],
    basis: artifacts
      ? `checked against the run's artifacts (${artifacts.contextPath})`
      : 'source only — references present, linkage unverified (pass --context to check them against the approved artifacts)',
  };
}

/**
 * The TC ids the scanned tests declare (exempt seed tests excluded).
 * @param {Traceability} traceability
 */
export function namedCases(traceability) {
  return new Set(
    traceability.tests.filter((t) => !t.exempt).flatMap((t) => t.ids.TC ?? [])
  );
}

/**
 * Read the artifacts a traceability check needs, from a context file.
 * Missing files are left null; nothing is written.
 * @returns {Gate4Artifacts | null}
 */
export function loadGate4Artifacts(contextPath = 'context.json') {
  if (!existsSync(contextPath)) return null;
  let context;
  try {
    context = JSON.parse(readFileSync(contextPath, 'utf8'));
  } catch {
    return null;
  }
  if (!context || typeof context !== 'object' || Array.isArray(context))
    return null;
  const paths = context.artifact_paths ?? {};
  const read = (/** @type {string | undefined} */ p) =>
    p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  let testCases = null;
  try {
    testCases = JSON.parse(read(paths.test_cases) ?? 'null');
  } catch {
    testCases = null;
  }
  return {
    contextPath,
    storyId: context.story?.id ?? null,
    testCases,
    testCasesPath: paths.test_cases ?? null,
    specText: read(paths.playwright_spec),
    specPath: paths.playwright_spec ?? null,
    criteria: Array.isArray(context.acceptance_criteria)
      ? context.acceptance_criteria.map(String)
      : null,
    track: storyTrack(context, read(context.story?.path || 'story.md')),
  };
}

/**
 * The track the scan holds a story to: the declared track (absent means
 * standard) or the story's floor, whichever is higher. The floor is computed
 * now from the story file and the context (scripts/track-floor.js), so a
 * floor the Analyst recorded too low does not lower it.
 * @param {any} context parsed context.json
 * @param {string | null} [story] the story file's text
 * @returns {string}
 */
export function storyTrack(context, story = null) {
  return effectiveTrack(context, story).track;
}

/**
 * Whether the findings block. On the full track every finding is unresolved
 * until it is fixed (no way to answer a finding exists yet), so the scan
 * exits non-zero; on any other track, or without the run's context, the
 * findings are informational. Either way Gate 4 stays the reviewer's.
 * @param {Gate4Artifacts | null | undefined} artifacts
 * @param {number} count findings across the scanned files
 * @returns {{ blocking: boolean, message: string }}
 */
export function scanVerdict(artifacts, count) {
  if (!artifacts)
    return {
      blocking: false,
      message:
        'Informational (no run context, so the track is unknown). Gate 4 is the human reviewer (CLAUDE.md §3.5).',
    };
  const track = artifacts.track ?? 'standard';
  if (track !== 'full')
    return {
      blocking: false,
      message: `Informational (${track} track). Gate 4 is the human reviewer (CLAUDE.md §3.5).`,
    };
  return count === 0
    ? {
        blocking: false,
        message:
          'Full track: no finding is open. Gate 4 is still the human reviewer (CLAUDE.md §3.5).',
      }
    : {
        blocking: true,
        message:
          `Full track: ${count} finding(s) unresolved; run on its own, the scan exits 1 for them. ` +
          'Fix each one in the test; a recorded answer per finding does not exist yet. ' +
          'This blocks nothing else and approves nothing: Gate 4 is the human reviewer (CLAUDE.md §3.5).',
      };
}

/**
 * Render a scan result as the runner's Gate-4 "auto-checks" block.
 * @param {string} filePath
 * @param {ReturnType<typeof gate4Findings>} result
 */
export function renderGate4Scan(filePath, result) {
  const lines = [`Gate-4 static scan — ${filePath}`];
  const tr = result.traceability ?? { tests: [], verified: [], basis: '' };
  const counted = tr.tests.filter((t) => !t.exempt).length;
  const exempt = tr.tests.length - counted;
  lines.push(
    `  Mechanical validation (the scan): ${counted} test(s) checked per test for PW / TC / SPEC ids` +
      (exempt
        ? `; ${exempt} exempt (seed test, documented non-business exception).`
        : '.')
  );
  lines.push(`  Linkage: ${tr.basis}`);
  for (const v of tr.verified) lines.push(`    - verified: ${v}`);
  if (result.findings.length === 0) {
    lines.push(
      '  Findings: none (no hard waits, suppression, fragile locators,'
    );
    lines.push(
      '  weak assertions, weak oracles, or per-test traceability gaps)'
    );
  } else {
    lines.push(`  Findings: ${result.findings.length} to confirm:`);
    for (const f of result.findings) {
      const where = f.line === null ? '' : `:${f.line}`;
      const inTest = f.test ? ` (in "${f.test}")` : '';
      lines.push(`  [${f.rule}]${where}${inTest} ${f.note}`);
      if (f.line !== null) lines.push(`      > ${f.excerpt}`);
    }
  }
  lines.push(
    '  Human judgment (Gate 4 — the scan does NOT answer these, and never approves):'
  );
  for (const q of result.judgment) lines.push(`    ? ${q}`);
  return lines.join('\n');
}

/**
 * The scan block of the runner's Gate-4 brief: the findings, then whether
 * they are informational or, on the full track, unresolved.
 * @param {string} filePath
 * @param {ReturnType<typeof gate4Findings>} result
 * @param {Gate4Artifacts | null | undefined} artifacts
 */
export function renderGate4Brief(filePath, result, artifacts) {
  const verdict = scanVerdict(artifacts, result.findings.length);
  return `${renderGate4Scan(filePath, result)}\n  ${verdict.message}`;
}

// ----------------------------------------------------------------- CLI -----
// Only when invoked directly (the module is also imported by the runner/tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = argv.slice(2);
  const ci = args.indexOf('--context');
  const contextPath = ci !== -1 ? args[ci + 1] : null;
  if (ci !== -1 && (!contextPath || !existsSync(contextPath))) {
    console.error(
      `--context needs an existing context.json (got ${contextPath ?? 'nothing'})`
    );
    exit(2);
  }
  const files = args.filter(
    (a, i) => !a.startsWith('--') && (ci === -1 || i !== ci + 1)
  );
  if (files.length === 0) {
    console.error(
      'Usage: node scripts/gate4-scan.js [--context context.json] <file> [<file> ...]'
    );
    exit(2);
  }
  const artifacts = contextPath ? loadGate4Artifacts(contextPath) : undefined;
  // A context that cannot be read must not pass as "no context": the track
  // it names would be lost and full-track findings would not block.
  if (contextPath && !artifacts) {
    console.error(
      `--context ${contextPath} is not a readable context.json object`
    );
    exit(2);
  }
  let total = 0;
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {string[]} */
  const unparsed = [];
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`File not found: ${f}`);
      exit(2);
    }
    const result = gate4Findings(readFileSync(f, 'utf8'), {
      fileName: f,
      artifacts,
      coverage: false,
    });
    for (const tc of namedCases(result.traceability)) named.add(tc);
    if (result.findings.some((x) => x.rule === 'unsupported_source'))
      unparsed.push(f);
    total += result.findings.length;
    console.log(renderGate4Scan(f, result));
    console.log('');
  }
  if (
    artifacts?.testCases &&
    artifacts.testCases.story_id === artifacts.storyId
  ) {
    const uncovered = uncoveredCases(artifacts.testCases, named);
    if (uncovered.length) {
      console.log(
        `Approved E2E cases no scanned test names: ${uncovered.join(', ')} [uncovered_case]` +
          (unparsed.length
            ? ` (${unparsed.join(', ')} did not parse, so the cases its tests name are unknown)`
            : '')
      );
      total += uncovered.length;
    } else console.log('Every approved E2E case is named by a scanned test.');
  }
  const verdict = scanVerdict(artifacts, total);
  console.log(
    `Scanned ${files.length} file(s); ${total} mechanical finding(s). ${verdict.message}`
  );
  exit(verdict.blocking ? 1 : 0);
}
