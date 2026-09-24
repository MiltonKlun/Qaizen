// Evidence-based failure classification (task group 3.3).
//
// Pure functions: a normalized ledger unit in, a cause + severity + stated
// reason out. No I/O.
//
// The previous classifier matched KEYWORDS anywhere in the error text, in an
// order that let the healing-eligible rules win. Verified on a real Chromium
// run, that produced:
//
//   B1  `expect(locator).toHaveText('$100.00')` against an element showing
//       `$1.00` -> green/locator_or_selector, because the message contains the
//       word "locator". A wrong business value became eligible for auto-fix.
//   --  Playwright colours its matcher hints (`expect(\x1b[31mreceived...`),
//       so the product-bug regex `expect\(received\)` never matched a real
//       report. The most important rule was dead code.
//   --  `test_bug` fired on the word "fixture" inside a file PATH embedded in
//       the message, not on anything that failed.
//
// This module reads what Playwright says actually FAILED -- the operation on
// the message's first line and its structured `Expected:` / `Received:` lines
// -- and applies evidence in the order the plan fixes:
//
//   1. established business assertion mismatch      -> red    / product_bug
//   2. explicit infrastructure failure               -> yellow / environment_issue
//   3. retry-flaky outcome (no stronger red cause)   -> yellow / flaky
//   4. proven non-assertion locator failure          -> green  / locator_or_selector
//        ...only when no Red-domain or semantic ambiguity; otherwise yellow
//   5. anything uncertain                            -> yellow / unknown_needs_human_review
//
// Green is the only severity that grants healing eligibility
// (docs/healer-guardrails.md), so it is the one that must be EARNED by
// positive evidence. When in doubt, this escalates.

import { redDomainsInText } from '../red-domains.js';

const ANSI = /\u001b\[[0-9;]*m/g;

/** Remove terminal colour codes. Real Playwright messages are full of them. */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

const NETWORK_CODE =
  /net::(ERR_[A-Z_]+)|\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH)\b|getaddrinfo/;

/**
 * Parse one Playwright error message into structured evidence.
 *
 * Only the message's own structure is read. File paths, snippets and call-log
 * noise are never keyword-matched for a cause.
 *
 * @returns {{
 *   kind: 'assertion'|'action'|'navigation'|'test_timeout'|'unknown',
 *   matcher: string|null, operation: string|null, locator: string|null,
 *   expected: string|null, received: string|null,
 *   elementNotFound: boolean, network: string|null, timedOut: boolean
 * }}
 */
export function parsePlaywrightError(message) {
  const text = stripAnsi(message);
  const lines = text.split('\n');
  const field = (name) => {
    const re = new RegExp(`^\\s*${name}(?: [a-z]+)?:\\s*(.*)$`, 'mi');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  const evidence = {
    kind: 'unknown',
    matcher: null,
    operation: null,
    locator: null,
    expected: field('Expected'),
    received: field('Received'),
    elementNotFound:
      /element\(s\) not found|no element(s)? (found|matching)/i.test(text),
    network: null,
    timedOut: /Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/i.test(
      text
    ),
  };

  const net = text.match(NETWORK_CODE);
  if (net) evidence.network = net[1] || net[2] || 'getaddrinfo';

  const locatorLine = text.match(/^\s*Locator:\s*(.+)$/m);
  const waitingFor = text.match(/waiting for (get\w+\(.*?\)|locator\(.*?\))/);
  evidence.locator = locatorLine
    ? locatorLine[1].trim()
    : waitingFor
      ? waitingFor[1]
      : null;

  // A matcher hint can sit below a custom message line
  // (`expect(total, 'order total')` puts "order total" on line 1).
  const matcher = text.match(
    /^\s*(?:Error:\s*)?expect\((locator|received|page)\)\.(?:not\.)?(\w+)\(/m
  );
  const firstLine = lines.find((l) => l.trim()) ?? '';
  const action = firstLine.match(
    /^(?:\w*Error:\s*)?(locator|page|frame|elementHandle|mouse|keyboard)\.(\w+):/
  );

  if (/^\s*Test timeout of \d+ms exceeded/m.test(firstLine)) {
    evidence.kind = 'test_timeout';
  } else if (matcher) {
    evidence.kind = 'assertion';
    evidence.matcher = matcher[2];
  } else if (action) {
    evidence.operation = `${action[1]}.${action[2]}`;
    evidence.kind =
      action[1] === 'page' &&
      /^(goto|reload|goBack|goForward|waitForURL)$/.test(action[2])
        ? 'navigation'
        : 'action';
  }

  return evidence;
}

/** A real value was observed and it differs from what the test required. */
function isValueMismatch(ev) {
  if (ev.kind !== 'assertion') return false;
  if (ev.elementNotFound) return false;
  if (ev.received === null || ev.received === '') return false;
  return ev.expected === null || ev.received !== ev.expected;
}

/**
 * Classify one Playwright unit from ALL of its attempts.
 *
 * Every attempt is inspected, not just the last: a flaky test whose failed
 * attempt showed a wrong total carries a stronger (red) cause than its
 * eventual pass.
 */
export function classifyPlaywrightUnit(unit) {
  const attempts = (unit.attempts || []).filter(
    (a) => a.status !== 'passed' && a.status !== 'skipped'
  );
  const evidence = attempts.map((a) => ({
    status: a.status,
    ...parsePlaywrightError(a.error_message),
  }));
  const title = unit.identity?.test_title ?? '';

  // 1. An observed business value that is wrong.
  const mismatch = evidence.find(isValueMismatch);
  if (mismatch) {
    return result('product_bug', 'red', evidence, [
      `assertion ${mismatch.matcher ?? ''} observed ${quote(mismatch.received)} ` +
        `where ${quote(mismatch.expected)} was required` +
        (mismatch.locator ? ` (on ${mismatch.locator})` : ''),
      'a wrong business value is Red: never auto-fixed (healer-guardrails)',
    ]);
  }

  // 2. The environment itself failed.
  const infra = evidence.find((e) => e.network);
  if (infra) {
    return result('environment_issue', 'yellow', evidence, [
      `${infra.operation ?? 'operation'} failed with ${infra.network}`,
    ]);
  }

  // 3. Unstable, with no stronger red cause found above.
  if (unit.outcome === 'flaky') {
    return result('flaky', 'yellow', evidence, [
      'failed, then passed on retry; no attempt showed a wrong business value',
    ]);
  }

  // 4. A locator that could not be found during an ACTION (click/fill/...).
  const locatorAction = evidence.find(
    (e) => e.kind === 'action' && e.timedOut && e.locator
  );
  if (locatorAction && evidence.every((e) => e.kind === 'action')) {
    const domains = redDomainsInText(`${title} ${locatorAction.locator}`);
    if (domains.length) {
      return result('locator_or_selector', 'yellow', evidence, [
        `${locatorAction.operation} could not find ${locatorAction.locator}`,
        `but the test touches Red domain(s): ${domains.join(', ')}; ` +
          'healing requires human approval',
      ]);
    }
    return result('locator_or_selector', 'green', evidence, [
      `${locatorAction.operation} timed out waiting for ${locatorAction.locator}`,
      'no assertion failed and no Red domain is involved',
    ]);
  }

  // 5. Everything else is uncertain and escalates.
  const missing = evidence.find(
    (e) => e.kind === 'assertion' && e.elementNotFound
  );
  if (missing) {
    return result('unknown_needs_human_review', 'yellow', evidence, [
      `assertion ${missing.matcher} found no element for ${missing.locator ?? 'its locator'}`,
      'ambiguous: the locator may be stale, or the product may not have rendered it',
    ]);
  }
  if (evidence.some((e) => e.kind === 'test_timeout')) {
    return result('unknown_needs_human_review', 'yellow', evidence, [
      'the whole test timed out without a specific failing operation',
    ]);
  }
  if (unit.outcome === 'blocked') {
    return result('unknown_needs_human_review', 'yellow', evidence, [
      'no trustworthy result: the attempt was interrupted or did not complete',
    ]);
  }
  return result('unknown_needs_human_review', 'yellow', evidence, [
    'the failure evidence does not establish a cause',
  ]);
}

/**
 * Classify one Newman unit. The healer never targets API tests, so nothing
 * here is ever green.
 */
export function classifyNewmanUnit(unit) {
  const transport = (unit.attempts || []).find((a) => a.status === 'failed');
  if (transport) {
    const code = stripAnsi(transport.error_message).match(NETWORK_CODE);
    const timedOut = /ETIMEDOUT|ESOCKETTIMEDOUT/.test(
      transport.error_message ?? ''
    );
    return result(
      timedOut ? 'unknown_needs_human_review' : 'environment_issue',
      'yellow',
      [],
      [
        `request did not complete${code ? ` (${code[1] || code[2]})` : ''}`,
        'transport failure, not a business assertion',
      ]
    );
  }

  const assertions = unit.assertions || [];
  if (assertions.length === 0) {
    return result(
      'test_bug',
      'yellow',
      [],
      ['the request asserted nothing, so it verified nothing']
    );
  }

  const failed = assertions.filter((a) => !a.passed);
  if (failed.length) {
    return result(
      'product_bug',
      'red',
      [],
      [
        `${failed.length} of ${assertions.length} assertion(s) failed: ` +
          failed.map((a) => a.name).join('; '),
        'the service responded, and its response was wrong',
      ]
    );
  }

  return result(
    'unknown_needs_human_review',
    'yellow',
    [],
    [`outcome ${unit.outcome} without a failed assertion or transport error`]
  );
}

/** Dispatch on runner kind. */
export function classifyUnit(unit) {
  return unit.identity?.kind === 'newman'
    ? classifyNewmanUnit(unit)
    : classifyPlaywrightUnit(unit);
}

/** Playwright already quotes string values; do not quote them twice. */
function quote(value) {
  if (value === null || value === undefined) return 'nothing';
  return /^".*"$/.test(value) ? value : `"${value}"`;
}

function result(classification, severity, evidence, reasons) {
  return { classification, severity, reason: reasons.join('; '), evidence };
}
