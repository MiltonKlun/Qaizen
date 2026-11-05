// @ts-check
// Weak-oracle checks for the Gate 4 scan (scripts/gate4-scan.js).
//
// A test is only as good as what it can fail on. These checks read the
// parsed test file and report, per test, the shapes that let a test pass
// whatever the product does: no assertion, only soft assertions, assertions
// that only run under a condition or whose failure is caught, checks that
// only assert something is absent, trivially true assertions, values the
// test supplied itself through a mocked response, expected values that no
// approved case or criterion states, and the settings that buy a pass with
// time or retries. Each finding is a question for the Gate 4 reviewer, never
// a verdict: the reviewer decides (CLAUDE.md §3.5).
//
// Pure: a parsed source file (and the run's artifacts, when known) in,
// findings out. No I/O.

import { WEAK_MATCHERS } from '../healer-guardrails.js';
import {
  expectBindings,
  lineOf,
  testChain,
  testIdentities,
  ts,
  visit,
} from './test-source.js';

/** An action, navigation or expect timeout above this needs a reason. */
export const LONG_TIMEOUT_MS = 30000;
/** A whole-test timeout above this needs a reason. */
export const LONG_TEST_TIMEOUT_MS = 120000;

/** Matchers whose literal arguments are an expected business value. */
const VALUE_MATCHERS = new Set([
  'toHaveText',
  'toContainText',
  'toHaveValue',
  'toHaveValues',
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toHaveCount',
  'toBeCloseTo',
  'toHaveAttribute',
  'toMatch',
  'toContain',
]);

/** Members between `expect(x)` and the matcher. */
const MODIFIERS = new Set(['not', 'resolves', 'rejects']);

/**
 * @typedef {{ node: ts.CallExpression, line: number, matcher: string,
 *   negated: boolean, soft: boolean, subject: ts.Expression | undefined,
 *   args: ts.NodeArray<ts.Expression> }} Assertion
 * @typedef {(rule: string, line: number | null, note: string,
 *   test?: string | null) => void} AddFinding
 * @typedef {{ testCases: any, storyId: string | null,
 *   criteria?: string[] | null }} OracleArtifacts
 */

/**
 * Names that hold a soft `expect`: `const s = expect.soft` or
 * `expect.configure({ soft: true })`.
 * @param {ts.SourceFile} sf
 * @param {Set<string>} expects
 */
function softNames(sf, expects) {
  /** @type {Set<string>} */
  const names = new Set();
  visit(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      expects.has(n.name.text) &&
      n.initializer &&
      isSoftCallee(n.initializer)
    )
      names.add(n.name.text);
  });
  return names;
}

/**
 * `expect.soft`, or `expect.configure({ soft: true })`.
 * @param {ts.Expression} e
 */
function isSoftCallee(e) {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'soft';
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'configure'
  ) {
    const opts = e.arguments[0];
    return (
      !!opts &&
      ts.isObjectLiteralExpression(opts) &&
      opts.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          propertyName(p) === 'soft' &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword
      )
    );
  }
  return false;
}

/** @param {ts.ObjectLiteralElementLike} p */
function propertyName(p) {
  const name = p.name;
  if (!name) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/**
 * Is this callee Playwright's `expect` (or a soft or polling form of it)?
 * @param {ts.Expression} callee
 * @param {Set<string>} expects
 * @param {Set<string>} soft
 * @returns {{ soft: boolean } | null}
 */
function expectCallee(callee, expects, soft) {
  let e = callee;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e))
    e = e.expression;
  if (ts.isIdentifier(e))
    return expects.has(e.text) ? { soft: soft.has(e.text) } : null;
  if (ts.isPropertyAccessExpression(e)) {
    const name = e.name.text;
    // `pw.expect` from a namespace import.
    if (name === 'expect') return { soft: false };
    if (name === 'soft' || name === 'poll') {
      const base = expectCallee(e.expression, expects, soft);
      return base ? { soft: base.soft || name === 'soft' } : null;
    }
    return null;
  }
  if (ts.isCallExpression(e)) {
    // expect.configure({ ... })(x)
    const inner = e.expression;
    if (
      ts.isPropertyAccessExpression(inner) &&
      inner.name.text === 'configure' &&
      expectCallee(inner.expression, expects, soft)
    )
      return { soft: isSoftCallee(e) };
  }
  return null;
}

/**
 * The assertion this call is, or null: `expect(x)[.not].matcher(...)`.
 * @param {ts.Node} n
 * @param {Set<string>} expects
 * @param {Set<string>} soft
 * @returns {Assertion | null}
 */
function assertionOf(n, expects, soft) {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))
    return null;
  const matcher = n.expression.name.text;
  if (MODIFIERS.has(matcher)) return null;
  let negated = false;
  let x = n.expression.expression;
  while (ts.isPropertyAccessExpression(x) && MODIFIERS.has(x.name.text)) {
    if (x.name.text === 'not') negated = true;
    x = x.expression;
  }
  if (!ts.isCallExpression(x)) return null;
  const callee = expectCallee(x.expression, expects, soft);
  if (!callee) return null;
  return {
    node: n,
    line: lineOf(n),
    matcher,
    negated,
    soft: callee.soft,
    subject: x.arguments[0],
    args: n.arguments,
  };
}

/** @param {ts.Node} block */
function throws(block) {
  let found = false;
  visit(block, (n) => {
    if (ts.isThrowStatement(n)) found = true;
  });
  return found;
}

/**
 * A `.catch(handler)` call whose handler never throws: it turns a failure
 * into a pass.
 * @param {ts.Node} n
 */
function isSwallowingCatch(n) {
  if (
    !ts.isCallExpression(n) ||
    !ts.isPropertyAccessExpression(n.expression) ||
    n.expression.name.text !== 'catch'
  )
    return false;
  const handler = n.arguments[0];
  if (!handler) return true;
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
    return !throws(handler.body);
  return false;
}

/**
 * How an assertion inside a test is guarded, if at all: under a condition,
 * or with its failure caught.
 * @param {ts.Node} node
 * @param {ts.Node} stop the test callback
 * @returns {{ conditional: boolean, swallowed: boolean }}
 */
function guardOf(node, stop) {
  let conditional = false;
  let swallowed = false;
  let child = node;
  for (let p = node.parent; p && p !== stop; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && child !== p.expression) conditional = true;
    else if (
      ts.isConditionalExpression(p) &&
      (child === p.whenTrue || child === p.whenFalse)
    )
      conditional = true;
    else if (
      ts.isBinaryExpression(p) &&
      child === p.right &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(p.operatorToken.kind)
    )
      conditional = true;
    else if (ts.isCaseClause(p) || ts.isDefaultClause(p)) conditional = true;
    else if (
      ts.isTryStatement(p) &&
      child === p.tryBlock &&
      p.catchClause &&
      !throws(p.catchClause.block)
    )
      swallowed = true;
    else if (
      ts.isPropertyAccessExpression(p) &&
      p.name.text === 'catch' &&
      child === p.expression &&
      p.parent &&
      isSwallowingCatch(p.parent)
    )
      swallowed = true;
  }
  return { conditional, swallowed };
}

/** @param {ts.Node} n */
function isFunctionLike(n) {
  return (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n)
  );
}

/**
 * In-file helpers by name: `function name() {}` and `const name = () => {}`.
 * @param {ts.SourceFile} sf
 * @returns {Map<string, ts.Node>}
 */
function helpersOf(sf) {
  /** @type {Map<string, ts.Node>} */
  const out = new Map();
  visit(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body)
      out.set(n.name.text, n.body);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    )
      out.set(n.name.text, n.initializer.body);
  });
  return out;
}

/**
 * The literal values an expression holds: strings, numbers, template text.
 * @param {ts.Node | undefined} node
 * @returns {string[]}
 */
function literalsIn(node) {
  /** @type {string[]} */
  const out = [];
  if (!node) return out;
  const take = (/** @type {ts.Node} */ n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      out.push(n.text);
    else if (ts.isNumericLiteral(n)) out.push(String(Number(n.text)));
    else if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(n.operand)
    )
      out.push(String(-Number(n.operand.text)));
  };
  visit(node, take);
  return [...new Set(out)];
}

/** @param {ts.Expression | undefined} e */
function isConstant(e) {
  if (!e) return false;
  return (
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && (e.text === 'undefined' || e.text === 'NaN'))
  );
}

/**
 * A trivially true form: weak matchers, and comparisons nothing can fail.
 * @param {Assertion} a
 */
function weakForm(a) {
  if (!a.negated && WEAK_MATCHERS.has(a.matcher)) return true;
  if (a.negated && a.matcher === 'toThrow') return true;
  if (a.negated && ['toBeNull', 'toBeUndefined', 'toBeNaN'].includes(a.matcher))
    return true;
  const arg = a.args[0];
  const num = arg ? literalsIn(arg)[0] : undefined;
  const infinite = arg && ts.isIdentifier(arg) && arg.text === 'Infinity';
  if (a.negated) return false;
  if (a.matcher === 'toBeGreaterThanOrEqual' && num === '0') return true;
  if (a.matcher === 'toBeGreaterThan' && num === '-1') return true;
  if (
    (a.matcher === 'toBeLessThan' || a.matcher === 'toBeLessThanOrEqual') &&
    infinite
  )
    return true;
  return false;
}

/**
 * The assertion only checks that something is absent.
 * @param {Assertion} a
 */
function isAbsence(a) {
  if (a.negated) return true;
  if (a.matcher === 'toBeHidden' || a.matcher === 'toBeDetached') return true;
  return a.matcher === 'toHaveCount' && literalsIn(a.args[0]).join() === '0';
}

/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Where an expected value could come from: the run's approved test cases
 * and the story's acceptance criteria, as one searchable text. Null when
 * the run's cases are not known.
 * @param {OracleArtifacts | null | undefined} artifacts
 */
function approvedText(artifacts) {
  const tc = artifacts?.testCases;
  if (!tc || tc.story_id !== artifacts?.storyId) return null;
  const cases = (tc.test_cases ?? []).filter(
    (/** @type {any} */ c) => c.status === 'approved'
  );
  const text = norm(
    [JSON.stringify(cases), ...(artifacts?.criteria ?? [])].join('\n')
  );
  return {
    text,
    numbers: new Set(numbersIn(text)),
    words: new Set(wordsIn(text)),
  };
}

/** @param {string} s */
const numbersIn = (s) => s.match(/\d+(?:[.,]\d+)*/g) ?? [];
/** @param {string} s */
const wordsIn = (s) =>
  s
    .replace(/\d+(?:[.,]\d+)*/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 1);

/**
 * Is this asserted literal stated anywhere the run approved? Word for word,
 * or by its parts: every number in it must appear as a number ("$39.98" is
 * found in "39.98", never in "39.99"), and every word as a word, so
 * "Thank you for your order!" is found in "a 'Thank you for your order'
 * message".
 * @param {string} literal
 * @param {{ text: string, numbers: Set<string>, words: Set<string> }} approved
 */
function traced(literal, approved) {
  const n = norm(literal);
  if (!n || approved.text.includes(n)) return true;
  const numbers = numbersIn(n);
  const words = wordsIn(n);
  if (numbers.length === 0 && words.length === 0) return true;
  return (
    numbers.every((d) => approved.numbers.has(d)) &&
    words.every((w) => approved.words.has(w))
  );
}

/**
 * Approved E2E cases that no test in the scanned files names.
 * @param {any} testCases the run's test-cases document
 * @param {Set<string>} named TC ids the tests declare
 * @returns {string[]}
 */
export function uncoveredCases(testCases, named) {
  return (testCases?.test_cases ?? [])
    .filter(
      (/** @type {any} */ c) =>
        c.status === 'approved' &&
        c.automation_decision === 'automate_e2e' &&
        !named.has(c.test_case_id)
    )
    .map((/** @type {any} */ c) => c.test_case_id);
}

/**
 * Report every weak-oracle shape in a parsed test file.
 * @param {ts.SourceFile} sf
 * @param {{ add: AddFinding, artifacts?: OracleArtifacts | null }} opts
 */
export function oracleFindings(sf, { add, artifacts = null }) {
  const expects = expectBindings(sf);
  const soft = softNames(sf, expects);
  const helpers = helpersOf(sf);
  const haystack = approvedText(artifacts);

  /** @type {Map<ts.Node, boolean>} */
  const helperAsserts = new Map();
  /**
   * Does this body assert, directly or through an in-file helper it calls?
   * @param {ts.Node} body
   * @param {Set<ts.Node>} seen
   * @returns {boolean}
   */
  const asserts = (body, seen = new Set()) => {
    if (helperAsserts.has(body))
      return /** @type {boolean} */ (helperAsserts.get(body));
    if (seen.has(body)) return false;
    seen.add(body);
    let found = false;
    visit(body, (n) => {
      if (found) return;
      if (assertionOf(n, expects, soft)) found = true;
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const h = helpers.get(n.expression.text);
        if (h && asserts(h, seen)) found = true;
      }
    });
    helperAsserts.set(body, found);
    return found;
  };

  // Values the file serves itself through a mocked route.
  /** @type {Set<string>} */
  const served = new Set();
  visit(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'fulfill'
    )
      for (const arg of n.arguments)
        for (const v of literalsIn(arg)) if (v.length >= 2) served.add(v);
  });

  const tests = testIdentities(sf);
  /** @type {Map<ts.Node, string>} */
  const labelOf = new Map();
  for (const t of tests) {
    const fn = [...t.node.arguments].reverse().find(isFunctionLike);
    if (fn) labelOf.set(fn, t.titlePath.join(' > '));
  }
  /** @param {ts.Node} n */
  const testOf = (n) => {
    for (let p = n.parent; p; p = p.parent)
      if (labelOf.has(p)) return /** @type {string} */ (labelOf.get(p));
    return null;
  };

  // File-wide: trivially true assertions, hard waits, positional locators.
  visit(sf, (n) => {
    const a = assertionOf(n, expects, soft);
    if (a) {
      if (isConstant(a.subject))
        add(
          'trivial_assertion',
          a.line,
          'the subject is a constant, so the result never depends on the product',
          testOf(n)
        );
      else if (weakForm(a))
        add(
          'weak_assertion',
          a.line,
          'weakened assertion — trivially-true form; assert the business value',
          testOf(n)
        );
    }
  });
  hardWaits(sf, add, testOf);
  positional(sf, add, testOf);

  for (const t of tests) {
    const fn =
      /** @type {ts.ArrowFunction | ts.FunctionExpression | undefined} */ (
        [...t.node.arguments].reverse().find(isFunctionLike)
      );
    if (!fn) continue;
    const label = t.titlePath.join(' > ');
    /** @type {Assertion[]} */
    const own = [];
    let viaHelper = false;
    visit(fn.body, (n) => {
      const a = assertionOf(n, expects, soft);
      if (a) own.push(a);
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const h = helpers.get(n.expression.text);
        if (h && asserts(h)) viaHelper = true;
      }
      if (isSwallowingCatch(n) && !own.some((a2) => isWithin(a2.node, n)))
        add(
          'swallowed_failure',
          lineOf(n),
          '.catch() with a handler that never throws turns a failure here into a pass; let it fail or assert the recovery',
          label
        );
      if (
        ts.isTryStatement(n) &&
        n.catchClause &&
        !throws(n.catchClause.block) &&
        !containsAssertion(n.tryBlock, expects, soft)
      )
        add(
          'swallowed_failure',
          lineOf(n),
          'try/catch that never rethrows turns a failure here into a pass; let it fail or assert the recovery',
          label
        );
    });

    if (own.length === 0 && !viaHelper) {
      add(
        'no_assertion',
        t.line,
        'no assertion in this test or the in-file helpers it calls: it passes whenever nothing throws (an imported helper may assert; check it)',
        label
      );
      continue;
    }

    /** @type {Assertion[]} */
    const firm = [];
    for (const a of own) {
      const g = guardOf(a.node, fn);
      if (g.swallowed)
        add(
          'swallowed_assertion',
          a.line,
          'the failure of this assertion is caught and never rethrown, so it cannot fail the test',
          label
        );
      else if (g.conditional)
        add(
          'conditional_assertion',
          a.line,
          'this assertion runs only under a condition; when the condition is false the test checks nothing',
          label
        );
      else firm.push(a);
      if (served.size && VALUE_MATCHERS.has(a.matcher)) {
        const echo = literalsIn(a.args[0]).find((v) =>
          [...served].some((s) => v === s || v.includes(s))
        );
        if (echo !== undefined)
          add(
            'mocked_oracle',
            a.line,
            `"${echo}" is asserted and also served by a mocked route in this file: the test may only check its own mock`,
            label
          );
      }
      if (haystack !== null && VALUE_MATCHERS.has(a.matcher)) {
        for (const v of literalsIn(a.args[0])) {
          if (!traced(v, haystack))
            add(
              'untraced_expected_value',
              a.line,
              `"${v}" is asserted but no approved test case or acceptance criterion states it; where does the expected value come from?`,
              label
            );
        }
      }
    }
    if (!viaHelper && own.length && own.every((a) => a.soft))
      add(
        'soft_only',
        t.line,
        'every assertion in this test is soft: it records failures but the remaining steps still run as if they passed; at least one must be a hard expect',
        label
      );
    if (!viaHelper && firm.length && firm.every(isAbsence))
      add(
        'absence_only',
        t.line,
        'this test only checks that something is absent or hidden; a page that renders nothing passes it',
        label
      );
  }

  timeoutsAndRetries(sf, add);
}

/**
 * Hard waits however they are reached: `page.waitForTimeout`,
 * `page['waitForTimeout']`, a bound alias of it, a bare or namespaced
 * `setTimeout`. A comment is never one. One finding per line.
 * @param {ts.SourceFile} sf
 * @param {AddFinding} add
 * @param {(n: ts.Node) => string | null} testOf
 */
function hardWaits(sf, add, testOf) {
  /** @type {Set<number>} */
  const lines = new Set();
  visit(sf, (n) => {
    const name = ts.isIdentifier(n)
      ? n.text
      : (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
          n.parent &&
          ts.isElementAccessExpression(n.parent) &&
          n.parent.argumentExpression === n
        ? n.text
        : null;
    if (name !== 'waitForTimeout' && name !== 'setTimeout') return;
    if (name === 'setTimeout' && isTestSetTimeout(n)) return;
    if (n.parent && ts.isImportSpecifier(n.parent)) return;
    const line = lineOf(n);
    if (lines.has(line)) return;
    lines.add(line);
    add(
      'hard_wait',
      line,
      'hard wait — needs a written justification or a deterministic wait (docs/review-gates.md Gate 4)',
      testOf(n)
    );
  });
}

/**
 * `test.setTimeout(n)` sets the test's timeout; it does not wait.
 * @param {ts.Node} n
 */
function isTestSetTimeout(n) {
  const access = n.parent;
  if (!access) return false;
  if (ts.isPropertyAccessExpression(access) && access.name === n)
    return testChain(access) !== null;
  if (ts.isElementAccessExpression(access) && access.argumentExpression === n)
    return testChain(access) !== null;
  return false;
}

/**
 * Positional locators: `.first()`, `.last()`, `.nth(i)` pick an element by
 * its place in the page, so a reordered page moves the test without failing
 * it.
 * @param {ts.SourceFile} sf
 * @param {AddFinding} add
 * @param {(n: ts.Node) => string | null} testOf
 */
function positional(sf, add, testOf) {
  visit(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ['first', 'last', 'nth'].includes(n.expression.name.text) &&
      (n.expression.name.text === 'nth'
        ? n.arguments.length === 1
        : n.arguments.length === 0)
    )
      add(
        'fragile_locator',
        lineOf(n),
        `positional locator (.${n.expression.name.text}()) — picks an element by its place on the page; prefer a unique role, label or test id`,
        testOf(n)
      );
  });
}

/**
 * @param {ts.Node} inner
 * @param {ts.Node} outer
 */
function isWithin(inner, outer) {
  for (let p = inner.parent; p; p = p.parent) if (p === outer) return true;
  return false;
}

/**
 * @param {ts.Node} node
 * @param {Set<string>} expects
 * @param {Set<string>} soft
 */
function containsAssertion(node, expects, soft) {
  let found = false;
  visit(node, (n) => {
    if (!found && assertionOf(n, expects, soft)) found = true;
  });
  return found;
}

/**
 * The settings that buy a pass with time or retries: test.slow(),
 * describe.configure({ retries }), a long test timeout, and a long action,
 * navigation or expect timeout.
 * @param {ts.SourceFile} sf
 * @param {AddFinding} add
 */
function timeoutsAndRetries(sf, add) {
  const long = (
    /** @type {ts.Expression | undefined} */ e,
    /** @type {number} */ limit
  ) => {
    if (!e || !ts.isNumericLiteral(e)) return false;
    const v = Number(e.text);
    return v === 0 || v > limit;
  };
  visit(sf, (n) => {
    if (ts.isCallExpression(n)) {
      const chain = testChain(n.expression);
      if (chain) {
        const last = chain[chain.length - 1];
        if (last === 'slow')
          add(
            'retries_or_slow',
            lineOf(n),
            'test.slow() triples the timeout; a slow test needs a written reason, not more time'
          );
        if (last === 'setTimeout' && long(n.arguments[0], LONG_TEST_TIMEOUT_MS))
          add(
            'long_timeout',
            lineOf(n),
            `a test timeout of 0 or above ${LONG_TEST_TIMEOUT_MS} ms hides a hang; justify it or wait for a specific state`
          );
        if (last === 'configure') {
          const opts = n.arguments[0];
          if (opts && ts.isObjectLiteralExpression(opts))
            for (const p of opts.properties)
              if (
                ts.isPropertyAssignment(p) &&
                propertyName(p) === 'retries' &&
                !(
                  ts.isNumericLiteral(p.initializer) &&
                  Number(p.initializer.text) === 0
                )
              )
                add(
                  'retries_or_slow',
                  lineOf(p),
                  'retries in the test file let a failure pass on a later attempt; a flaky test needs fixing, not retrying'
                );
        }
      } else if (
        ts.isPropertyAccessExpression(n.expression) &&
        /^setDefault(Navigation)?Timeout$/.test(n.expression.name.text) &&
        long(n.arguments[0], LONG_TIMEOUT_MS)
      )
        add(
          'long_timeout',
          lineOf(n),
          `a default timeout of 0 or above ${LONG_TIMEOUT_MS} ms hides a missing element; justify it`
        );
    }
    if (
      ts.isPropertyAssignment(n) &&
      ['timeout', 'actionTimeout', 'navigationTimeout'].includes(
        propertyName(n) ?? ''
      ) &&
      long(n.initializer, LONG_TIMEOUT_MS) &&
      !isInRetriesConfigure(n)
    )
      add(
        'long_timeout',
        lineOf(n),
        `a timeout of 0 or above ${LONG_TIMEOUT_MS} ms lets a missing element or a slow regression pass; justify it`
      );
  });
}

/**
 * A `timeout` inside `test.describe.configure({ ... })` is a test timeout,
 * checked with the test-timeout limit instead.
 * @param {ts.PropertyAssignment} p
 */
function isInRetriesConfigure(p) {
  const obj = p.parent;
  const call = obj?.parent;
  if (!call || !ts.isCallExpression(call)) return false;
  const chain = testChain(call.expression);
  if (!chain || chain[chain.length - 1] !== 'configure') return false;
  const v = ts.isNumericLiteral(p.initializer) ? Number(p.initializer.text) : 0;
  return v !== 0 && v <= LONG_TEST_TIMEOUT_MS;
}
