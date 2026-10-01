// @ts-check
// Locators as the test source writes them (task group 9.1, review finding I7).
//
// The selector-survival script used to pull locators out with regexes: it
// kept a getByRole's role but dropped its accessible name, turned every other
// named locator into getByText, and lost the scope a locator was chained
// from. A removed "Login" button then "survived" because some other button
// existed. This reads the parsed source instead (scripts/lib/test-source.js):
// every locator chain keeps its root, each step's method, and each argument,
// option object and regex literal exactly as written. Anything that is not a
// static expression (a variable, a template with substitutions, a nested
// locator) is reported as unmeasurable with the reason, never approximated.
//
// This is source inspection only. A survival rate is measured by running
// reviewed probe functions against the app (scripts/selector-survival.js
// --probe), because a locator rebuilt from text is not the locator the test
// runs.

import { parseTestSource, lineOf, ts } from './test-source.js';

/** Methods that locate elements. */
const LOCATE = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
]);
/** Methods that narrow a located set. */
const REFINE = new Set(['first', 'last', 'nth', 'filter']);
const STEP = new Set([...LOCATE, ...REFINE]);

/**
 * A static value (`value`) or the reason it is not one (`dynamic`).
 * @typedef {{ value?: any, dynamic?: string }} StaticResult
 * @typedef {{ method: string, args: any[] }} Step
 * @typedef {{ id?: string, line: number, root: string, steps: Step[],
 *   expression: string, measurable: boolean, reason?: string }} Locator
 */

/** @returns {string | null} */
const stepName = (/** @type {ts.Node} */ call) =>
  ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : null;

/**
 * A static argument value, or `{ dynamic: reason }`.
 * Strings are the cooked value (escapes resolved), regexes keep their source.
 * @param {ts.Expression} node
 * @returns {StaticResult}
 */
export function staticValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.text };
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return { value: { regex: node.text } };
  }
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { value: -Number(node.operand.text) };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (ts.isObjectLiteralExpression(node)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const p of node.properties) {
      if (
        !ts.isPropertyAssignment(p) ||
        !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ) {
        return { dynamic: 'an option that is not a plain `key: value`' };
      }
      const v = staticValue(p.initializer);
      if (v.dynamic) return { dynamic: `option ${p.name.text}: ${v.dynamic}` };
      out[p.name.text] = v.value;
    }
    return { value: out };
  }
  if (ts.isIdentifier(node))
    return { dynamic: `the variable \`${node.text}\`` };
  if (ts.isTemplateExpression(node)) {
    return { dynamic: 'a template string with substitutions' };
  }
  if (ts.isCallExpression(node) && STEP.has(stepName(node) ?? '')) {
    return { dynamic: 'a nested locator' };
  }
  return { dynamic: `a ${ts.SyntaxKind[node.kind]} expression` };
}

/**
 * A value rendered back as a JS literal.
 * @param {any} v
 * @returns {string}
 */
function render(v) {
  if (v && typeof v === 'object' && 'regex' in v) return v.regex;
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${k}: ${render(x)}`)
      .join(', ')} }`;
  }
  // Single-quoted, as test sources usually write them: a CSS selector's inner
  // double quotes stay readable.
  return typeof v === 'string'
    ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
    : String(v);
}

/**
 * Every locator chain in a test source, outermost chains only.
 * @returns {{ok: true, locators: Array<Locator & { id: string }>}
 *   | {ok: false, reason: string}}
 * @param {string} text
 * @param {string} [fileName]
 */
export function extractLocators(text, fileName = 'test.spec.ts') {
  const parsed = parseTestSource(text, fileName);
  if (!parsed.ok) return parsed;
  /** @type {Locator[]} */
  const locators = [];
  const walk = (/** @type {ts.Node} */ node) => {
    if (ts.isCallExpression(node) && STEP.has(stepName(node) ?? '')) {
      // Only the outermost call of a chain: an inner call is its scope.
      const access = node.parent;
      const continued =
        access &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        access.parent &&
        STEP.has(stepName(access.parent) ?? '');
      if (!continued) {
        const chain = chainOf(node);
        if (chain) locators.push(chain);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed.sourceFile);
  locators.forEach((l, i) => (l.id = `L${i + 1}`));
  return {
    ok: true,
    locators: /** @type {Array<Locator & { id: string }>} */ (locators),
  };
}

/**
 * @param {ts.CallExpression} outer
 * @returns {Locator | null}
 */
function chainOf(outer) {
  /** @type {ts.CallExpression[]} */
  const calls = [];
  /** @type {ts.Expression} */
  let node = outer;
  while (ts.isCallExpression(node) && STEP.has(stepName(node) ?? '')) {
    calls.unshift(node);
    // stepName() is non-null only for a property-access callee.
    node = /** @type {ts.PropertyAccessExpression} */ (node.expression)
      .expression;
  }
  // A chain with no locating step (an array's .filter()) is not a locator.
  if (!calls.some((c) => LOCATE.has(stepName(c) ?? ''))) return null;
  const root = node.getText();
  /** @type {string[]} */
  const reasons = [];
  if (!ts.isIdentifier(node) || node.text !== 'page') {
    reasons.push(
      `its scope \`${root}\` is defined elsewhere, so the chain is incomplete here`
    );
  }
  const steps = calls.map((c) => {
    const method = stepName(c) ?? '';
    const args = c.arguments.map((a, i) => {
      const v = staticValue(a);
      if (v.dynamic)
        reasons.push(`${method} argument ${i + 1} is ${v.dynamic}`);
      return v.dynamic ? { dynamic: a.getText() } : v.value;
    });
    return { method, args };
  });
  const expression =
    root +
    steps
      .map(
        (s) =>
          `.${s.method}(${s.args
            .map((a) => (a && a.dynamic ? a.dynamic : render(a)))
            .join(', ')})`
      )
      .join('');
  return {
    line: lineOf(outer),
    root,
    steps,
    expression,
    measurable: reasons.length === 0,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}
