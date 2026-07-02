#!/usr/bin/env node
// Pre-Gate-4 static scan (IMPROVEMENT-PLAN Phase 6, IP-6.2 / PFI-5). Surfaces
// the MECHANICAL Gate-4 findings so the human reviewer spends judgment, not
// archaeology. It INFORMS and NEVER fixes: it does not edit files, does not
// decide the gate, and changes nothing about the approval bar. Gate 4 is
// always a human decision (CLAUDE.md §3.5) — this just hands the reviewer the
// checklist's mechanical half pre-answered so they can focus on the rest.
//
// gate4Findings(source) -> { findings: [{ rule, line, excerpt, note }],
//                            judgment: string[] }
// The pure function takes a test's source text; the CLI runs it over files.
// Weak-assertion and skip detection REUSE the guardrail constants
// (scripts/healer-guardrails.js) — one source of truth, no duplicated regex.
//
// Checks (all mechanical — a human still judges business correctness):
//   - hard waits: page.waitForTimeout(...) / bare setTimeout(...)
//   - test suppression: .skip / .fixme / .only  (SKIP_PATTERN + .only)
//   - fragile locators: :nth-child, .nth(, index XPath [n], long CSS chains
//   - weak assertions: toBeTruthy/toBeDefined/.not.toThrow (WEAK_ASSERTION_PATTERN)
//   - missing traceability: no TC-XXX / SPEC-XXX / PW-XXX reference anywhere
//
// Usage:
//   node scripts/gate4-scan.js <file> [<file> ...]
//   npm run scan:gate4 -- tests/STORY-1.spec.ts
//
// Exit codes: 0 scan ran (findings are INFORMATIONAL, never a failure) ·
//   2 usage / unreadable file. It never exits non-zero on findings — flagging
//   a brittle locator is not the script's call to block; the human decides.

import { readFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';
import { SKIP_PATTERN, WEAK_ASSERTION_PATTERN } from './healer-guardrails.js';
import { GATE4_JUDGMENT_QUESTIONS } from './gate-briefs.js';

// Per-rule line matchers. Each returns true if the LINE trips the rule.
// Kept line-oriented so findings can point at a line number + excerpt.
const LINE_RULES = [
  {
    rule: 'hard_wait',
    note: 'hard wait — needs a written justification or a deterministic wait (docs/review-gates.md Gate 4)',
    test: (l) => /\.waitForTimeout\s*\(|(^|[^.\w])setTimeout\s*\(/.test(l),
  },
  {
    rule: 'test_suppression',
    note: 'skipped/only test — .skip/.fixme/.only is a Gate-4 rejection',
    test: (l) => SKIP_PATTERN.test(l) || /\.only\s*\(/.test(l),
  },
  {
    rule: 'fragile_locator',
    note: 'fragile locator — nth-child / .nth() / index XPath / long CSS chain; prefer a stable hook or role',
    test: (l) =>
      /:nth-child\(|\.nth\(|\/\/[^'"`]*\[\d+\]/.test(l) ||
      // a CSS string with 3+ descendant combinators is a brittle chain
      /['"`][^'"`]*(?:\s+>?\s*[.#][\w-]+){3,}[^'"`]*['"`]/.test(l),
  },
  {
    rule: 'weak_assertion',
    note: 'weakened assertion — trivially-true form; assert the business value',
    test: (l) => WEAK_ASSERTION_PATTERN.test(l),
  },
];

/**
 * Scan one test source. Returns mechanical findings + the human judgment
 * questions (the footer the reviewer still has to answer themselves).
 */
export function gate4Findings(source) {
  const findings = [];
  const lines = (source || '').split('\n');
  lines.forEach((line, i) => {
    for (const r of LINE_RULES) {
      if (r.test(line)) {
        findings.push({
          rule: r.rule,
          line: i + 1,
          excerpt: line.trim().slice(0, 100),
          note: r.note,
        });
      }
    }
  });

  // Traceability is a whole-file property, not a per-line one: the test must
  // reference at least one TC/SPEC/PW id somewhere (comment or metadata).
  if (!/\b(TC|SPEC|PW)-\d+/.test(source || '')) {
    findings.push({
      rule: 'missing_traceability',
      line: null,
      excerpt: '(whole file)',
      note: 'no TC-/SPEC-/PW- reference — the test cannot be mapped back to its case (docs/traceability.md)',
    });
  }

  return { findings, judgment: GATE4_JUDGMENT_QUESTIONS() };
}

/** Render a scan result as the runner's Gate-4 "auto-checks" block. */
export function renderGate4Scan(filePath, result) {
  const lines = [`Gate-4 static scan — ${filePath}`];
  if (result.findings.length === 0) {
    lines.push('  mechanical checks: clean (no hard waits, suppression,');
    lines.push('  fragile locators, weak assertions, or missing traceability)');
  } else {
    lines.push(`  ${result.findings.length} mechanical finding(s) to confirm:`);
    for (const f of result.findings) {
      const where = f.line === null ? '' : `:${f.line}`;
      lines.push(`  [${f.rule}]${where} ${f.note}`);
      if (f.line !== null) lines.push(`      > ${f.excerpt}`);
    }
  }
  lines.push('  Judgment — only you can answer (the scan does NOT):');
  for (const q of result.judgment) lines.push(`    ? ${q}`);
  return lines.join('\n');
}

// ----------------------------------------------------------------- CLI -----
// Only when invoked directly (the module is also imported by the runner/tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: node scripts/gate4-scan.js <file> [<file> ...]');
    exit(2);
  }
  let total = 0;
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`File not found: ${f}`);
      exit(2);
    }
    const result = gate4Findings(readFileSync(f, 'utf8'));
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
