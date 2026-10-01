#!/usr/bin/env node
// @ts-check
// Pre-Gate-4 static scan (IMPROVEMENT-PLAN Phase 6, IP-6.2 / PFI-5). Surfaces
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
//   - hard waits: page.waitForTimeout(...) / bare setTimeout(...)
//   - fragile locators: :nth-child, .nth(, index XPath [n], long CSS chains
//   - test suppression: .skip / .fixme / .only / .fail, from the parsed test
//     registrations (aliases resolved, comments ignored)
//   - weak assertions: toBeTruthy / toBeDefined / toBeFalsy / .not.toThrow
//   - traceability, PER TEST (task group 6.2, finding S4): every generated
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
// Exit codes: 0 scan ran (findings are INFORMATIONAL, never a failure) ·
//   2 usage / unreadable file. It never exits non-zero on findings — flagging
//   a brittle locator is not the script's call to block; the human decides.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

import { WEAK_MATCHERS } from './healer-guardrails.js';
import { GATE4_JUDGMENT_QUESTIONS } from './gate-briefs.js';
import {
  TEST_ID_KINDS,
  expectBindings,
  lineOf,
  parseTestSource,
  testIdentities,
  testRegistrations,
  ts,
  visit,
} from './lib/test-source.js';

/**
 * What a traceability check reads, from loadGate4Artifacts.
 * @typedef {{ contextPath: string, storyId: string | null, testCases: any,
 *   testCasesPath: string | null, specText: string | null,
 *   specPath: string | null }} Gate4Artifacts
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
    rule: 'hard_wait',
    note: 'hard wait — needs a written justification or a deterministic wait (docs/review-gates.md Gate 4)',
    test: (l) => /\.waitForTimeout\s*\(|(^|[^.\w])setTimeout\s*\(/.test(l),
  },
  {
    rule: 'fragile_locator',
    note: 'fragile locator — nth-child / .nth() / index XPath / long CSS chain; prefer a stable hook or role',
    test: (l) =>
      /:nth-child\(|\.nth\(|\/\/[^'"`]*\[\d+\]/.test(l) ||
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
 * @returns {{ findings: Finding[], traceability: Traceability,
 *   judgment: string[] }}
 */
export function gate4Findings(
  source,
  { fileName = 'test.spec.ts', artifacts } = {}
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

  const expects = expectBindings(sf);
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))
      return;
    const matcher = n.expression.name.text;
    let root = n.expression.expression;
    /** @type {string[]} */
    const chain = [];
    while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) {
      if (ts.isPropertyAccessExpression(root)) chain.push(root.name.text);
      root = root.expression;
    }
    if (!ts.isIdentifier(root) || !expects.has(root.text)) return;
    const weak =
      WEAK_MATCHERS.has(matcher) ||
      (matcher === 'toThrow' && chain.includes('not'));
    if (weak) {
      add(
        'weak_assertion',
        lineOf(n),
        'weakened assertion — trivially-true form; assert the business value'
      );
    }
  });

  const traceability = checkTraceability(sf, fileName, artifacts, add);
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
    lines.push('  weak assertions, or per-test traceability gaps)');
  } else {
    lines.push(`  Findings: ${result.findings.length} to confirm:`);
    for (const f of result.findings) {
      const where = f.line === null ? '' : `:${f.line}`;
      lines.push(`  [${f.rule}]${where} ${f.note}`);
      if (f.line !== null) lines.push(`      > ${f.excerpt}`);
    }
  }
  lines.push(
    '  Human judgment (Gate 4 — the scan does NOT answer these, and never approves):'
  );
  for (const q of result.judgment) lines.push(`    ? ${q}`);
  return lines.join('\n');
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
  let total = 0;
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`File not found: ${f}`);
      exit(2);
    }
    const result = gate4Findings(readFileSync(f, 'utf8'), {
      fileName: f,
      artifacts,
    });
    total += result.findings.length;
    console.log(renderGate4Scan(f, result));
    console.log('');
  }
  console.log(
    `Scanned ${files.length} file(s); ${total} mechanical finding(s). ` +
      'Informational — Gate 4 is the human reviewer (CLAUDE.md §3.5).'
  );
  exit(0);
}
