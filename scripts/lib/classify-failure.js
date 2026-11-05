// @ts-check
// Evidence-based failure classification.
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
// -- and applies evidence in this fixed order:
//
//   1. established business assertion mismatch      -> red    / product_bug
//   2. explicit infrastructure failure               -> yellow / environment_issue
//   3. retry-flaky outcome (no stronger red cause)   -> yellow / flaky
//   4. proven non-assertion locator failure          -> green  / locator_or_selector
//        ...only when every failed attempt timed out on an action the Healer
//        may repair (click, fill, ...), the locator does not find its element
//        by text content or by a number or price, no Red domain is in the
//        test or its locator, the test case is linked to no high-severity or
//        Red-domain risk, and most of the run did not fail; otherwise yellow
//   5. anything uncertain                            -> yellow / unknown_needs_human_review
//
// Green is the only severity that grants healing eligibility
// (docs/healer-guardrails.md), so it is the one that must be EARNED by
// positive evidence. When in doubt, this escalates. The message text is
// still trusted: test code that throws its own error worded like an action
// timeout reads as one.

import { redDomainsInText } from '../red-domains.js';

/** @typedef {import('./execution-ledger.js').Unit} Unit */
/**
 * What the run knows about a unit beyond its own messages.
 * @typedef {{
 *   risks?: { risk_id: string, severity?: string, description?: string }[],
 *   systemic?: { failed: number, units: number } | null
 * }} RunContext
 */
/**
 * @typedef {{
 *   kind: 'assertion'|'action'|'navigation'|'test_timeout'|'unknown',
 *   matcher: string|null, operation: string|null, locator: string|null,
 *   target: string|null,
 *   expected: string|null, received: string|null,
 *   elementNotFound: boolean, network: string|null, timedOut: boolean
 * }} ErrorEvidence
 * @typedef {ErrorEvidence & { status: string }} AttemptEvidence
 * @typedef {{ classification: string, severity: 'red'|'yellow'|'green',
 *   reason: string, evidence: AttemptEvidence[] }} Classification
 */

// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC (\x1b); matching it is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Remove terminal colour codes. Real Playwright messages are full of them.
 * @param {unknown} text
 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * The only locator operations whose timeout can be Green: the actions the
 * Healer may repair (REPAIRABLE_ACTIONS in scripts/lib/test-source.js; a test
 * keeps the two lists equal). Every other operation (waitFor, innerText,
 * textContent, inputValue, isVisible, count, getAttribute, ...) reads or waits
 * for something, and its timeout may be the outcome the test checks.
 */
export const GREEN_ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'press',
  'pressSequentially',
  'check',
  'uncheck',
  'selectOption',
  'hover',
  'setInputFiles',
]);

/**
 * The quoted arguments of a locator chain: what it looks for, without its
 * method names.
 * @param {string | null} target
 * @returns {string[]}
 */
function quotedValues(target) {
  return [...String(target ?? '').matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(
    (m) => m[2]
  );
}

/**
 * Why a locator finds its element by what the page shows, or null. A text
 * engine (text=, getByText, :has-text, :text) finds an element by its
 * content; a role name, label, placeholder, alt text or title with a number,
 * and any quoted value with a currency sign, finds it by a value. Either way a
 * missing element may be a wrong value, not a stale locator.
 * @param {string | null} target the failing locator chain
 * @returns {string | null}
 */
export function valueBearing(target) {
  if (!target) return null;
  if (
    /\btext=|getByText\(|internal:text=|:has-text\(|:has-not-text\(|:text(?:-is|-matches)?\(/i.test(
      target
    )
  )
    return 'finds its element by text content';
  const texts = [
    ...target.matchAll(/name:\s*(['"`])((?:\\.|(?!\1).)*)\1/g),
    ...target.matchAll(
      /getBy(?:Label|Placeholder|AltText|Title)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
    ),
  ].map((m) => m[2]);
  if (texts.some((t) => /\d/.test(t)))
    return 'finds its element by a number in its visible name';
  if (quotedValues(target).some((t) => /[$€£¥₹¢]/.test(t)))
    return 'finds its element by a price';
  return null;
}

const NETWORK_CODE =
  /net::(ERR_[A-Z_]+)|\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH)\b|getaddrinfo/;

/**
 * Parse one Playwright error message into structured evidence.
 *
 * Only the message's own structure is read. File paths, snippets and call-log
 * noise are never keyword-matched for a cause.
 *
 * @param {string | undefined} message
 * @returns {ErrorEvidence}
 */
export function parsePlaywrightError(message) {
  const text = stripAnsi(message);
  const lines = text.split('\n');
  const field = (/** @type {string} */ name) => {
    const re = new RegExp(`^\\s*${name}(?: [a-z]+)?:\\s*(.*)$`, 'mi');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  /** @type {ErrorEvidence} */
  const evidence = {
    kind: 'unknown',
    matcher: null,
    operation: null,
    locator: null,
    target: null,
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
  // The whole chain the operation waited for, not just its first call:
  // `locator('#cart').getByText('$5')` matters past `locator('#cart')`.
  const chain = text.match(
    /waiting for ((?:get\w+|locator|frameLocator|internal:\w+)\(.*?)(?:\s+to be \w+)?\s*$/m
  );
  evidence.target = chain ? chain[1] : evidence.locator;

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

/**
 * A timeout on this operation may be Green: `locator.<repairable action>`.
 * @param {string | null} operation e.g. `locator.click`
 */
function isGreenAction(operation) {
  const [receiver, method] = String(operation ?? '').split('.');
  return receiver === 'locator' && GREEN_ACTIONS.has(method);
}

/**
 * A real value was observed and it differs from what the test required.
 * @param {ErrorEvidence} ev
 */
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
 * @param {Unit} unit
 * @param {RunContext} [run] the unit's linked risks and the run's failure share
 * @returns {Classification}
 */
export function classifyPlaywrightUnit(unit, run = {}) {
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
    /** @type {string[]} */
    const but = [];
    const read = evidence.find((e) => !isGreenAction(e.operation));
    if (read)
      but.push(
        `${read.operation} reads or waits for something, so its timeout may be the outcome the test checks`
      );
    const valued = evidence
      .map((e) => valueBearing(e.target))
      .find((v) => v !== null);
    if (valued)
      but.push(`the locator ${valued}, so the value itself may be wrong`);
    // Only what the locator looks for counts, not its method names:
    // `getByRole` is not a permission.
    const sought = evidence.flatMap((e) => quotedValues(e.target)).join(' ');
    const domains = redDomainsInText(`${title} ${sought}`);
    if (domains.length)
      but.push(`the test touches Red domain(s): ${domains.join(', ')}`);
    for (const r of run.risks ?? []) {
      if (r.severity === 'high')
        but.push(`its test case covers high-severity ${r.risk_id}`);
      const riskDomains = redDomainsInText(r.description ?? '');
      if (riskDomains.length)
        but.push(
          `its test case covers ${r.risk_id}, a Red domain (${riskDomains.join(', ')})`
        );
    }
    if (run.systemic)
      but.push(
        `${run.systemic.failed} of ${run.systemic.units} Playwright tests in this run failed, ` +
          'which points to the app or the environment, not one locator'
      );
    if (but.length) {
      return result(
        read || valued ? 'unknown_needs_human_review' : 'locator_or_selector',
        'yellow',
        evidence,
        [
          `${locatorAction.operation} could not find ${locatorAction.locator}`,
          `but ${but.join('; ')}; healing requires human approval`,
        ]
      );
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
 * @param {Unit} unit
 * @returns {Classification}
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

/**
 * Dispatch on runner kind.
 * @param {Unit} unit
 * @param {RunContext} [run]
 */
export function classifyUnit(unit, run = {}) {
  return unit.identity?.kind === 'newman'
    ? classifyNewmanUnit(unit)
    : classifyPlaywrightUnit(unit, run);
}

/**
 * Whether most of the run's Playwright tests failed: at least two failed or
 * were blocked, and they are more than half. One failing test is never
 * systemic. Null when the run is not.
 * @param {Unit[]} units every unit of the run
 * @returns {{ failed: number, units: number } | null}
 */
export function systemicFailure(units) {
  const pw = units.filter((u) => u.identity?.kind === 'playwright');
  const failed = pw.filter(
    (u) => u.outcome === 'failed' || u.outcome === 'blocked'
  ).length;
  return failed >= 2 && failed * 2 > pw.length
    ? { failed, units: pw.length }
    : null;
}

/**
 * Playwright already quotes string values; do not quote them twice.
 * @param {string | null | undefined} value
 */
function quote(value) {
  if (value === null || value === undefined) return 'nothing';
  return /^".*"$/.test(value) ? value : `"${value}"`;
}

/**
 * @param {string} classification
 * @param {Classification['severity']} severity
 * @param {AttemptEvidence[]} evidence
 * @param {string[]} reasons
 * @returns {Classification}
 */
function result(classification, severity, evidence, reasons) {
  return { classification, severity, reason: reasons.join('; '), evidence };
}
