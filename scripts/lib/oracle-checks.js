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
 * A rejection handler that turns a failure into a pass: anything but a
 * function that throws (`console.error`, `noop`, `() => {}`, `() => null`).
 * @param {ts.Expression | undefined} handler
 */
function swallows(handler) {
  if (!handler) return true;
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
    return !throws(handler.body);
  return true;
}

/**
 * `.catch(h)` or `.then(ok, h)` whose handler swallows the failure.
 * @param {ts.Node} n
 */
function isSwallowingCatch(n) {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))
    return false;
  const name = n.expression.name.text;
  if (name === 'catch') return swallows(n.arguments[0]);
  if (name === 'then' && n.arguments.length >= 2)
    return swallows(n.arguments[1]);
  return false;
}

/**
 * How a node inside a function is guarded, if at all: under a condition, or
 * with its failure caught.
 * @param {ts.Node} node
 * @param {ts.Node} stop the enclosing test callback or helper
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
      (p.name.text === 'catch' || p.name.text === 'then') &&
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
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n)
  );
}

/**
 * In-file helpers: functions a test can call by name (`function f() {}`,
 * `const f = () => {}`) and methods it can call on an object (a class or
 * object-literal method `check() {}` or `check: () => {}`, called as
 * `x.check()`).
 * @param {ts.SourceFile} sf
 * @returns {{ byName: Map<string, ts.Node>, byMethod: Map<string, ts.Node[]> }}
 */
function helpersOf(sf) {
  /** @type {Map<string, ts.Node>} */
  const byName = new Map();
  /** @type {Map<string, ts.Node[]>} */
  const byMethod = new Map();
  const method = (/** @type {string} */ name, /** @type {ts.Node} */ fn) =>
    byMethod.set(name, [...(byMethod.get(name) ?? []), fn]);
  visit(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body)
      byName.set(n.name.text, n);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    )
      byName.set(n.name.text, n.initializer);
    if (ts.isMethodDeclaration(n) && n.body && ts.isIdentifier(n.name))
      method(n.name.text, n);
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    )
      method(n.name.text, n.initializer);
  });
  return { byName, byMethod };
}

/**
 * The in-file helpers a call may run.
 * @param {ts.Node} n
 * @param {ReturnType<typeof helpersOf>} helpers
 * @returns {ts.Node[]}
 */
function calleesOf(n, helpers) {
  if (!ts.isCallExpression(n)) return [];
  if (ts.isIdentifier(n.expression)) {
    const h = helpers.byName.get(n.expression.text);
    return h ? [h] : [];
  }
  if (ts.isPropertyAccessExpression(n.expression))
    return helpers.byMethod.get(n.expression.name.text) ?? [];
  return [];
}

/** @param {ts.Node} fn */
const bodyOf = (fn) =>
  ts.isArrowFunction(fn) ||
  ts.isFunctionExpression(fn) ||
  ts.isFunctionDeclaration(fn) ||
  ts.isMethodDeclaration(fn)
    ? fn.body
    : undefined;

/**
 * The literal values an expression holds: strings, numbers, template text.
 * Properties named in `skip` are not read (a mocked response's status).
 * @param {ts.Node | undefined} node
 * @param {Set<string>} [skip]
 * @returns {string[]}
 */
function literalsIn(node, skip) {
  /** @type {string[]} */
  const out = [];
  if (!node) return out;
  const walk = (/** @type {ts.Node} */ n) => {
    if (skip && ts.isPropertyAssignment(n) && skip.has(propertyName(n) ?? ''))
      return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      out.push(n.text);
    else if (ts.isNumericLiteral(n)) out.push(String(numberOf(n.text)));
    else if (
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(n.operand)
    ) {
      out.push(String(-numberOf(n.operand.text)));
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return [...new Set(out)];
}

/** @param {string} text a numeric literal's text, separators allowed */
const numberOf = (text) => Number(text.replace(/_/g, ''));

/**
 * The value of a numeric expression the file fixes: a literal, constant
 * arithmetic (`10 * 60_000`), or a `const` declared in the file with such a
 * value. Null when it cannot be known statically.
 * @param {ts.Expression | undefined} e
 * @param {Map<string, ts.Expression>} consts
 * @param {number} [depth]
 * @returns {number | null}
 */
function numericValue(e, consts, depth = 0) {
  if (!e || depth > 8) return null;
  if (ts.isNumericLiteral(e)) return numberOf(e.text);
  if (ts.isParenthesizedExpression(e))
    return numericValue(e.expression, consts, depth + 1);
  if (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken
  ) {
    const v = numericValue(e.operand, consts, depth + 1);
    return v === null ? null : -v;
  }
  if (ts.isBinaryExpression(e)) {
    const a = numericValue(e.left, consts, depth + 1);
    const b = numericValue(e.right, consts, depth + 1);
    if (a === null || b === null) return null;
    switch (e.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return a * b;
      case ts.SyntaxKind.PlusToken:
        return a + b;
      case ts.SyntaxKind.MinusToken:
        return a - b;
      case ts.SyntaxKind.SlashToken:
        return b === 0 ? null : a / b;
      default:
        return null;
    }
  }
  if (ts.isIdentifier(e)) {
    const init = consts.get(e.text);
    return init ? numericValue(init, consts, depth + 1) : null;
  }
  return null;
}

/**
 * Top-level and nested `const` declarations with an initializer, by name.
 * A name declared more than once is left out: its value is not fixed.
 * @param {ts.SourceFile} sf
 */
function constsOf(sf) {
  /** @type {Map<string, ts.Expression>} */
  const out = new Map();
  /** @type {Set<string>} */
  const twice = new Set();
  visit(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      n.parent &&
      ts.isVariableDeclarationList(n.parent) &&
      n.parent.flags & ts.NodeFlags.Const
    ) {
      if (out.has(n.name.text)) twice.add(n.name.text);
      out.set(n.name.text, n.initializer);
    }
  });
  for (const name of twice) out.delete(name);
  return out;
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
 * A trivially true form: weak matchers, comparisons nothing can fail, and a
 * value compared with itself.
 * @param {Assertion} a
 */
function weakForm(a) {
  if (!a.negated && WEAK_MATCHERS.has(a.matcher)) return true;
  if (a.negated && a.matcher === 'toThrow') return true;
  if (a.negated && ['toBeNull', 'toBeUndefined', 'toBeNaN'].includes(a.matcher))
    return true;
  if (a.negated) return false;
  const arg = a.args[0];
  const num = arg ? literalsIn(arg)[0] : undefined;
  const infinite = arg && ts.isIdentifier(arg) && arg.text === 'Infinity';
  if (a.matcher === 'toBeGreaterThanOrEqual' && num === '0') return true;
  if (a.matcher === 'toBeGreaterThan' && num === '-1') return true;
  if (
    (a.matcher === 'toBeLessThan' || a.matcher === 'toBeLessThanOrEqual') &&
    infinite
  )
    return true;
  return (
    ['toBe', 'toEqual', 'toStrictEqual'].includes(a.matcher) &&
    !!a.subject &&
    !!arg &&
    a.subject.getText() === arg.getText()
  );
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

/**
 * The argument of a value matcher that holds the expected value: the
 * attribute's value for `toHaveAttribute(name, value)`, else the first.
 * @param {Assertion} a
 */
const expectedArg = (a) =>
  a.matcher === 'toHaveAttribute' ? a.args[1] : a.args[0];

/** @param {string} s */
const norm = (s) =>
  s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
/** @param {string} s */
const numbersIn = (s) => s.match(/\d+(?:[.,]\d+)*/g) ?? [];
/** @param {string} s */
const wordsIn = (s) =>
  s
    .replace(/\d+(?:[.,]\d+)*/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 1);
/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Small whole numbers as cases write them in words (English and Spanish):
 * "two items" states the 2 a test asserts.
 * @type {Record<string, string[]>}
 */
const NUMBER_WORDS = {
  0: ['zero', 'none', 'cero', 'ninguno', 'ninguna'],
  1: ['one', 'single', 'uno', 'una', 'un'],
  2: ['two', 'both', 'dos', 'ambos', 'ambas'],
  3: ['three', 'tres'],
  4: ['four', 'cuatro'],
  5: ['five', 'cinco'],
  6: ['six', 'seis'],
  7: ['seven', 'siete'],
  8: ['eight', 'ocho'],
  9: ['nine', 'nueve'],
  10: ['ten', 'diez'],
  11: ['eleven', 'once'],
  12: ['twelve', 'doce'],
};

/** The fields of a test case that state what it checks. */
const CASE_CONTENT = [
  'title',
  'description',
  'preconditions',
  'steps',
  'expected_results',
];

/**
 * Every string a value holds, depth first.
 * @param {unknown} v
 * @returns {string[]}
 */
function stringsOf(v) {
  if (typeof v === 'string') return [v];
  if (typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsOf);
  return [];
}

/**
 * What an approved source states, ready to search: its text, its numbers and
 * its words.
 * @typedef {{ text: string, numbers: Set<string>, words: Set<string> }} Stated
 */

/**
 * @param {string[]} parts
 * @returns {Stated}
 */
function stated(parts) {
  const text = norm(parts.join('\n'));
  return {
    text,
    numbers: new Set(numbersIn(text)),
    words: new Set(wordsIn(text)),
  };
}

/**
 * Where a test's expected values may come from: the content of the approved
 * cases it names (all approved cases when it names none of them) and the
 * story's acceptance criteria. Ids, statuses and field names are never
 * part of it. Null when the run's cases are not known.
 * @param {OracleArtifacts | null | undefined} artifacts
 */
function approvedSources(artifacts) {
  const tc = artifacts?.testCases;
  if (!tc || tc.story_id !== artifacts?.storyId) return null;
  /** @type {Map<string, string[]>} */
  const byCase = new Map();
  for (const c of tc.test_cases ?? []) {
    if (c.status !== 'approved') continue;
    byCase.set(
      c.test_case_id,
      CASE_CONTENT.flatMap((k) => stringsOf(c[k]))
    );
  }
  const criteria = (artifacts?.criteria ?? []).map(String);
  /** @param {string[]} named */
  return (named) => {
    const own = named.filter((id) => byCase.has(id));
    const cases = own.length ? own : [...byCase.keys()];
    return stated([
      ...cases.flatMap((id) => byCase.get(id) ?? []),
      ...criteria,
    ]);
  };
}

/**
 * Is this asserted literal stated by an approved source? As a whole phrase
 * at word boundaries, or by its parts: every number in it must appear as a
 * whole number ("$39.98" is found in "39.98", never in "39.99" or
 * "139.98"), and every word as a whole word, so "Thank you for your order!"
 * is found in "a 'Thank you for your order' message".
 * @param {string} literal
 * @param {Stated} approved
 */
function traced(literal, approved) {
  const n = norm(literal);
  if (!n) return true;
  const numbers = numbersIn(n);
  const words = wordsIn(n);
  if (numbers.length === 0 && words.length === 0) return true;
  const phrase = new RegExp(
    `(?<![\\p{L}\\d])${escapeRe(n)}(?![\\p{L}\\d])`,
    'u'
  );
  if (phrase.test(approved.text)) return true;
  return (
    numbers.every(
      (d) =>
        approved.numbers.has(d) ||
        (NUMBER_WORDS[d] ?? []).some((w) => approved.words.has(w))
    ) && words.every((w) => approved.words.has(w))
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
  const consts = constsOf(sf);
  const sourcesFor = approvedSources(artifacts);

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
    if (!a) return;
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
  });
  hardWaits(sf, add, testOf);
  positional(sf, add, testOf);
  timeoutsAndRetries(sf, add, consts, expects, soft);

  // Values the file serves itself through a mocked route.
  const SERVED_SKIP = new Set(['status', 'contentType', 'headers']);
  /** @type {string[]} */
  const served = [];
  visit(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'fulfill'
    )
      for (const arg of n.arguments)
        served.push(...literalsIn(arg, SERVED_SKIP));
  });
  const servedStated = stated(served);
  const servedText = new Set(served.map(norm));
  /** @param {string} v */
  const echoes = (v) => {
    if (servedText.has(norm(v))) return true;
    const numbers = numbersIn(norm(v));
    return (
      numbers.length > 0 && numbers.every((d) => servedStated.numbers.has(d))
    );
  };

  /** Guard findings are made once per assertion line, whichever test runs it. */
  /** @type {Set<string>} */
  const reported = new Set();
  /**
   * @param {string} rule
   * @param {number} line
   * @param {string} note
   * @param {string} label
   */
  const once = (rule, line, note, label) => {
    const key = `${rule}:${line}`;
    if (reported.has(key)) return;
    reported.add(key);
    add(rule, line, note, label);
  };

  /**
   * Every assertion a function runs, its own and through the in-file helpers
   * it calls, each with how it is guarded. A helper call under a condition
   * or a swallowing catch passes that guard to the helper's assertions.
   * @param {ts.Node} fn
   * @param {{ conditional: boolean, swallowed: boolean }} outer
   * @param {Set<ts.Node>} seen
   * @returns {(Assertion & { conditional: boolean, swallowed: boolean, helper: boolean })[]}
   */
  const reach = (fn, outer, seen, helper = false) => {
    if (seen.has(fn)) return [];
    seen.add(fn);
    const body = bodyOf(fn);
    if (!body) return [];
    /** @type {(Assertion & { conditional: boolean, swallowed: boolean, helper: boolean })[]} */
    const out = [];
    visit(body, (n) => {
      const a = assertionOf(n, expects, soft);
      if (a) {
        const g = guardOf(n, fn);
        out.push({
          ...a,
          conditional: outer.conditional || g.conditional,
          swallowed: outer.swallowed || g.swallowed,
          helper,
        });
        return;
      }
      for (const h of calleesOf(n, helpers)) {
        const g = guardOf(n, fn);
        out.push(
          ...reach(
            h,
            {
              conditional: outer.conditional || g.conditional,
              swallowed: outer.swallowed || g.swallowed,
            },
            seen,
            true
          )
        );
      }
    });
    return out;
  };

  for (const t of tests) {
    const fn =
      /** @type {ts.ArrowFunction | ts.FunctionExpression | undefined} */ (
        [...t.node.arguments].reverse().find(isFunctionLike)
      );
    if (!fn) continue;
    const label = t.titlePath.join(' > ');
    const all = reach(fn, { conditional: false, swallowed: false }, new Set());

    visit(fn.body, (n) => {
      const inside = (/** @type {ts.Node} */ outer) =>
        all.some((a) => isWithin(a.node, outer));
      if (isSwallowingCatch(n) && !inside(n))
        add(
          'swallowed_failure',
          lineOf(n),
          'a .catch() or .then() handler that never throws turns a failure here into a pass; let it fail or assert the recovery',
          label
        );
      if (
        ts.isTryStatement(n) &&
        n.catchClause &&
        !throws(n.catchClause.block) &&
        !inside(n.tryBlock)
      )
        add(
          'swallowed_failure',
          lineOf(n),
          'try/catch that never rethrows turns a failure here into a pass; let it fail or assert the recovery',
          label
        );
    });

    if (all.length === 0) {
      add(
        'no_assertion',
        t.line,
        'no assertion in this test or the in-file helpers and methods it calls: it passes whenever nothing throws (an imported helper may assert; check it)',
        label
      );
      continue;
    }

    const named = Object.values(t.ids.TC ?? {}).flat();
    const sources = sourcesFor ? sourcesFor(named) : null;
    const where = (/** @type {{ helper: boolean }} */ a) =>
      a.helper ? ' (in a helper this test calls)' : '';
    for (const a of all) {
      if (a.swallowed)
        once(
          'swallowed_assertion',
          a.line,
          `the failure of this assertion is caught and never rethrown, so it cannot fail the test${where(a)}`,
          label
        );
      else if (a.conditional)
        once(
          'conditional_assertion',
          a.line,
          `this assertion runs only under a condition; when the condition is false the test checks nothing${where(a)}`,
          label
        );
      if (!VALUE_MATCHERS.has(a.matcher)) continue;
      const values = literalsIn(expectedArg(a));
      const echo = served.length ? values.find(echoes) : undefined;
      if (echo !== undefined)
        once(
          'mocked_oracle',
          a.line,
          `"${echo}" is asserted and also served by a mocked route in this file: the test may only check its own mock`,
          label
        );
      // An absence check expects nothing; its 0 is not a business value.
      if (sources && !isAbsence(a))
        for (const v of values)
          if (!traced(v, sources))
            add(
              'untraced_expected_value',
              a.line,
              `"${v}" is asserted but neither the approved test cases this test names nor the acceptance criteria state it; where does the expected value come from?`,
              label
            );
    }
    const firm = all.filter((a) => !a.conditional && !a.swallowed);
    if (all.every((a) => a.soft))
      add(
        'soft_only',
        t.line,
        'every assertion this test runs is soft: it records failures but the remaining steps still run as if they passed; at least one must be a hard expect',
        label
      );
    if (firm.length && firm.every(isAbsence))
      add(
        'absence_only',
        t.line,
        'this test only checks that something is absent or hidden; a page that renders nothing passes it',
        label
      );
  }
}

/** Modules whose `setTimeout` is a promise you can await as a hard wait. */
const TIMER_MODULES = new Set(['timers/promises', 'node:timers/promises']);
/** Receivers of `x.setTimeout(...)` that schedule a wait. */
const TIMER_HOSTS = new Set(['globalThis', 'window', 'global', 'self']);

/**
 * Hard waits however they are reached: `page.waitForTimeout`,
 * `page['waitForTimeout']`, a bound or destructured alias of it, a bare,
 * global or `timers/promises` `setTimeout` (an imported alias included).
 * A comment is never one; `test.setTimeout` and `testInfo.setTimeout` set a
 * timeout and are not. One finding per line.
 * @param {ts.SourceFile} sf
 * @param {AddFinding} add
 * @param {(n: ts.Node) => string | null} testOf
 */
function hardWaits(sf, add, testOf) {
  /** Local names of `setTimeout` imported from a timers module. */
  /** @type {Set<string>} */
  const timerNames = new Set();
  for (const st of sf.statements) {
    if (
      !ts.isImportDeclaration(st) ||
      !ts.isStringLiteral(st.moduleSpecifier) ||
      !TIMER_MODULES.has(st.moduleSpecifier.text)
    )
      continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named))
      for (const el of named.elements)
        if ((el.propertyName ?? el.name).text === 'setTimeout')
          timerNames.add(el.name.text);
  }
  /** @type {Set<number>} */
  const lines = new Set();
  const flag = (/** @type {ts.Node} */ n) => {
    const line = lineOf(n);
    if (lines.has(line)) return;
    lines.add(line);
    add(
      'hard_wait',
      line,
      'hard wait — needs a written justification or a deterministic wait (docs/review-gates.md Gate 4)',
      testOf(n)
    );
  };
  visit(sf, (n) => {
    // A call to an imported alias: `await sleep(3000)`.
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      timerNames.has(n.expression.text) &&
      n.expression.text !== 'setTimeout'
    ) {
      flag(n);
      return;
    }
    const name = ts.isIdentifier(n)
      ? n.text
      : (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
          n.parent &&
          ts.isElementAccessExpression(n.parent) &&
          n.parent.argumentExpression === n
        ? n.text
        : null;
    if (name !== 'waitForTimeout' && name !== 'setTimeout') return;
    const p = n.parent;
    if (!p) return;
    // A name in an import, an object key, or a declaration of a property.
    if (
      ts.isImportSpecifier(p) ||
      (ts.isPropertyAssignment(p) && p.name === n) ||
      (ts.isMethodDeclaration(p) && p.name === n)
    )
      return;
    if (name === 'setTimeout') {
      const access =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isElementAccessExpression(p) && p.argumentExpression === n)
          ? p
          : null;
      if (access) {
        // `window.setTimeout = ...` replaces it; it does not wait.
        const host = /** @type {ts.Expression} */ (
          /** @type {any} */ (access).expression
        );
        if (
          access.parent &&
          ts.isBinaryExpression(access.parent) &&
          access.parent.left === access
        )
          return;
        const isTimerHost =
          (ts.isIdentifier(host) && TIMER_HOSTS.has(host.text)) ||
          (ts.isCallExpression(host) &&
            ts.isIdentifier(host.expression) &&
            host.expression.text === 'require' &&
            host.arguments[0] &&
            ts.isStringLiteral(host.arguments[0]) &&
            TIMER_MODULES.has(host.arguments[0].text));
        if (!isTimerHost) return;
      }
      // Only a call waits: `x = window.setTimeout` keeps a reference.
      const callee = access ?? n;
      if (
        !callee.parent ||
        !ts.isCallExpression(callee.parent) ||
        callee.parent.expression !== callee
      )
        return;
    }
    flag(n);
  });
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
      !n.questionDotToken &&
      ts.isPropertyAccessExpression(n.expression) &&
      !n.expression.questionDotToken &&
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

/** Locator and page methods whose options bag holds an action, navigation or wait timeout. */
const TIMED_METHODS = new Set([
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
  'tap',
  'type',
  'focus',
  'clear',
  'dragTo',
  'waitFor',
  'goto',
  'reload',
  'goBack',
  'goForward',
  'waitForURL',
  'waitForLoadState',
  'waitForSelector',
]);

/**
 * A property (or shorthand) named `name` in an object literal, with its value.
 * @param {ts.ObjectLiteralExpression} obj
 * @param {string} name
 * @returns {{ node: ts.Node, value: ts.Expression } | null}
 */
function prop(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p) === name)
      return { node: p, value: p.initializer };
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name)
      return { node: p, value: p.name };
  }
  return null;
}

/**
 * The settings that buy a pass with time or retries: test.slow(),
 * describe.configure({ retries }), a long test timeout (test.setTimeout,
 * test details, describe.configure), and a long action, navigation or
 * expect timeout (an action's or a matcher's options, expect.configure,
 * test.use, page.setDefaultTimeout). Values are read through constant
 * arithmetic and `const` declarations in the file.
 * @param {ts.SourceFile} sf
 * @param {AddFinding} add
 * @param {Map<string, ts.Expression>} consts
 * @param {Set<string>} expects
 * @param {Set<string>} soft
 */
function timeoutsAndRetries(sf, add, consts, expects, soft) {
  /** @param {ts.Expression | undefined} e @param {number} limit */
  const long = (e, limit) => {
    const v = numericValue(e, consts);
    return v !== null && (v === 0 || v > limit);
  };
  const testLimit = (/** @type {ts.Node} */ at) =>
    add(
      'long_timeout',
      lineOf(at),
      `a test timeout of 0 or above ${LONG_TEST_TIMEOUT_MS} ms hides a hang; justify it or wait for a specific state`
    );
  const actionLimit = (/** @type {ts.Node} */ at) =>
    add(
      'long_timeout',
      lineOf(at),
      `an action, navigation or expect timeout of 0 or above ${LONG_TIMEOUT_MS} ms lets a missing element or a slow regression pass; justify it`
    );
  /** @param {ts.Expression | undefined} opts @param {string[]} names */
  const checkBag = (opts, names) => {
    if (!opts || !ts.isObjectLiteralExpression(opts)) return;
    for (const name of names) {
      const p = prop(opts, name);
      if (p && long(p.value, LONG_TIMEOUT_MS)) actionLimit(p.node);
    }
  };

  visit(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
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
        testLimit(n);
      const opts = n.arguments.find(ts.isObjectLiteralExpression);
      if (last === 'configure' && opts) {
        const retries = prop(opts, 'retries');
        if (retries && numericValue(retries.value, consts) !== 0)
          add(
            'retries_or_slow',
            lineOf(retries.node),
            'retries in the test file let a failure pass on a later attempt; a flaky test needs fixing, not retrying'
          );
        const timeout = prop(opts, 'timeout');
        if (timeout && long(timeout.value, LONG_TEST_TIMEOUT_MS))
          testLimit(timeout.node);
      } else if (last === 'use' && opts) {
        checkBag(opts, ['actionTimeout', 'navigationTimeout']);
      } else if (opts && n.arguments.some(isFunctionLike)) {
        // Test details: test('title', { timeout }, fn).
        const timeout = prop(opts, 'timeout');
        if (timeout && long(timeout.value, LONG_TEST_TIMEOUT_MS))
          testLimit(timeout.node);
      }
      return;
    }
    // A matcher's options, expect(x, { timeout }), expect.configure({ timeout }).
    const a = assertionOf(n, expects, soft);
    if (a) {
      checkBag(a.args[a.args.length - 1], ['timeout']);
      return;
    }
    if (ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (method === 'configure' || method === 'poll')
        checkBag(n.arguments[n.arguments.length - 1], ['timeout']);
      else if (TIMED_METHODS.has(method))
        checkBag(n.arguments[n.arguments.length - 1], ['timeout']);
      else if (
        /^setDefault(Navigation)?Timeout$/.test(method) &&
        long(n.arguments[0], LONG_TIMEOUT_MS)
      )
        actionLimit(n);
    } else if (ts.isIdentifier(n.expression) && expects.has(n.expression.text))
      checkBag(n.arguments[1], ['timeout']);
  });
}
