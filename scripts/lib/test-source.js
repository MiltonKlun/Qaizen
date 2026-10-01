// @ts-check
// Parsed view of a Playwright test file (task group 6.1; reused by 6.2).
//
// The Healer guardrails used regexes over raw text, which counted `test(`
// inside comments, missed negated matchers, and ignored suppression that was
// "already present somewhere". This module parses the source with the
// TypeScript compiler API (already installed for `npm run typecheck`; no new
// dependency) and exposes what a comparison needs:
//
//   - syntax diagnostics (unsupported source is rejected, never guessed at);
//   - a canonical form of the executable code with positions, whitespace and
//     comments removed, so formatting never counts as a change and a change
//     to executable code always does;
//   - the test registrations (tests, hooks, suppression) resolved through the
//     file's own imports, so an alias like `import { test as t }` is seen;
//   - the traceability ids written anywhere in the file, comments included.
//
// Parsing proves structure, not meaning: two files with the same structure
// can still select different elements. Callers keep a human in the loop.

import ts from 'typescript';

/** Traceability ids the pipeline writes into test sources. */
export const TRACE_ID = /\b(?:TC|PW|SPEC|API|REQ|RISK|FAIL|BUG)-\d+\b/g;

/** Member names that suppress or focus a test or a group. */
export const SUPPRESSION = ['skip', 'fixme', 'only', 'fail'];

/** Hook names on the test object. */
const HOOKS = ['beforeEach', 'afterEach', 'beforeAll', 'afterAll'];

/**
 * One call on the `test` object.
 * @typedef {{ kind: 'hook' | 'config' | 'group' | 'test' | 'call',
 *   chain: string, suppression: string[], title: string | null,
 *   dynamic: boolean, line: number, node: ts.CallExpression }} Registration
 */

/**
 * Parse JS/TS test source.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {{ok: true, sourceFile: ts.SourceFile} | {ok: false, reason: string}}
 */
export function parseTestSource(text, fileName = 'candidate.spec.ts') {
  const kind = /\.(m|c)?jsx?$/i.test(fileName)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind
  );
  // Syntax errors only (no type checking): the parser records them here.
  // `parseDiagnostics` is not in the public typings, but it is where the
  // parser keeps syntax errors.
  const diagnostics =
    /** @type {{ parseDiagnostics?: ts.DiagnosticWithLocation[] }} */ (
      /** @type {unknown} */ (sourceFile)
    ).parseDiagnostics ?? [];
  if (diagnostics.length) {
    const d = diagnostics[0];
    const { line } = sourceFile.getLineAndCharacterOfPosition(d.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    return {
      ok: false,
      reason: `unsupported source: syntax error at line ${line + 1} (${message})`,
    };
  }
  return { ok: true, sourceFile };
}

/**
 * 1-based line of a node.
 * @param {ts.Node} node
 */
export function lineOf(node) {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

// ---------------------------------------------------------------- bindings

/**
 * Local names bound to Playwright's `test` object: named imports of `test`
 * (aliases included) and constants derived with `.extend(...)`.
 * @param {ts.SourceFile} sourceFile
 * @returns {Set<string>}
 */
export function testBindings(sourceFile) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'test' || imported === 'it') names.add(el.name.text);
    }
  }
  // No import provides the test object (a fragment, or a global setup):
  // fall back to the global names rather than miss a registration.
  if (names.size === 0) {
    names.add('test');
    names.add('it');
  }
  // const test = base.extend({...}) — possibly chained.
  let grew = true;
  while (grew) {
    grew = false;
    visit(sourceFile, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === 'extend' &&
        names.has(
          rootIdentifier(node.initializer.expression.expression) ?? ''
        ) &&
        !names.has(node.name.text)
      ) {
        names.add(node.name.text);
        grew = true;
      }
    });
  }
  return names;
}

/**
 * The identifier at the root of `a.b.c` / `a`, or null.
 * @param {ts.Expression} expr
 */
function rootIdentifier(expr) {
  let e = expr;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

/**
 * ['test', 'describe', 'only'] for `test.describe.only`, or null.
 * @param {ts.Expression} expr
 */
function memberChain(expr) {
  /** @type {string[]} */
  const parts = [];
  let e = expr;
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text);
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return null;
  parts.unshift(e.text);
  return parts;
}

const isFunctionArg = (/** @type {ts.Node} */ a) =>
  ts.isArrowFunction(a) || ts.isFunctionExpression(a);

/**
 * Every call on the `test` object: declarations, groups, hooks, and
 * suppression calls — each with its kind, modifiers, title and line.
 * @param {ts.SourceFile} sourceFile
 * @returns {Registration[]}
 */
export function testRegistrations(sourceFile) {
  const bindings = testBindings(sourceFile);
  /** @type {Registration[]} */
  const out = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const chain = memberChain(node.expression);
    if (!chain || !bindings.has(chain[0])) return;
    const members = chain.slice(1);
    if (members.includes('extend') || members.includes('step')) return;
    // Configuration calls register nothing.
    if (members.some((m) => m === 'use' || m === 'setTimeout' || m === 'info'))
      return;

    const hasBody = node.arguments.some(isFunctionArg);
    const title = node.arguments[0];
    const staticTitle =
      title &&
      (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
        ? title.text
        : null;
    /** @type {Registration['kind']} */
    let kind;
    if (members.some((m) => HOOKS.includes(m))) kind = 'hook';
    else if (members.includes('describe'))
      kind = members.includes('configure') ? 'config' : 'group';
    else if (hasBody) kind = 'test';
    else kind = 'call'; // e.g. test.skip(condition, 'reason') inside a body
    out.push({
      kind,
      chain: chain.join('.'),
      suppression: members.filter((m) => SUPPRESSION.includes(m)),
      title: staticTitle,
      dynamic:
        (kind === 'test' || kind === 'group') &&
        (staticTitle === null || registeredDynamically(node, bindings)),
      line: lineOf(node),
      node,
    });
  });
  return out;
}

/**
 * A registration made inside a loop, a conditional, or a callback other than
 * a describe body is dynamic: how many tests it creates is not static.
 * @param {ts.CallExpression} call
 * @param {Set<string>} bindings
 */
function registeredDynamically(call, bindings) {
  let n = call.parent;
  while (n && !ts.isSourceFile(n)) {
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isIfStatement(n) ||
      ts.isConditionalExpression(n) ||
      ts.isSwitchStatement(n)
    ) {
      return true;
    }
    if (isFunctionArg(n)) {
      // Allowed only as the body of a describe group.
      const owner = n.parent;
      const chain =
        owner && ts.isCallExpression(owner)
          ? memberChain(owner.expression)
          : null;
      if (!chain || !bindings.has(chain[0]) || !chain.includes('describe')) {
        return true;
      }
    }
    n = n.parent;
  }
  return false;
}

// ---------------------------------------------------------------- fixture

/**
 * Is the identifier `page` in this file provably the Playwright page fixture?
 * True only when every declaration of `page` is a `{ page }` binding in the
 * parameters of a test/hook callback, and `page` is never reassigned.
 * @param {ts.SourceFile} sourceFile
 */
export function pageIsFixture(sourceFile) {
  const bindings = testBindings(sourceFile);
  let ok = true;
  visit(sourceFile, (node) => {
    if (!ok) return;
    if (ts.isIdentifier(node) && node.text === 'page') {
      const p = node.parent;
      // Declarations of `page`.
      if (
        (ts.isVariableDeclaration(p) && p.name === node) ||
        (ts.isParameter(p) && p.name === node) ||
        ts.isImportSpecifier(p) ||
        ts.isImportClause(p) ||
        ts.isNamespaceImport(p) ||
        (ts.isFunctionDeclaration(p) && p.name === node)
      ) {
        ok = false;
        return;
      }
      if (ts.isBindingElement(p) && p.name === node) {
        // `{ page }` exactly (no rename, no default) in a test/hook callback.
        const fn = p.parent?.parent?.parent;
        const call = fn?.parent;
        const chain =
          call && ts.isCallExpression(call)
            ? memberChain(call.expression)
            : null;
        if (
          p.propertyName ||
          p.initializer ||
          !chain ||
          !bindings.has(chain[0])
        ) {
          ok = false;
        }
        return;
      }
      if (ts.isBindingElement(p) && p.propertyName === node) {
        ok = false; // { page: somethingElse }
        return;
      }
      // Reassignment.
      if (
        ts.isBinaryExpression(p) &&
        p.left === node &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        ok = false;
      }
    }
  });
  return ok;
}

// ---------------------------------------------------------------- canonical

const LOCATOR_METHODS = new Set(['locator', 'getByTestId']);

/**
 * Local names bound to Playwright's `expect` (aliases included).
 * @param {ts.SourceFile} sourceFile
 */
export function expectBindings(sourceFile) {
  const names = new Set(['expect']);
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if ((el.propertyName ?? el.name).text === 'expect')
        names.add(el.name.text);
    }
  }
  return names;
}

/**
 * The string literals an automatic repair may change: the first argument of
 * `page.locator('...')` / `page.getByTestId('...')`, where `page` is provably
 * the fixture and the locator is used directly by an action in the same
 * statement. Excluded, because their value can decide what an assertion
 * checks: a locator inside `expect(...)`, and a locator stored in a variable.
 * @param {ts.SourceFile} sourceFile
 * @returns {Set<ts.Node>}
 */
export function repairableLocators(sourceFile) {
  /** @type {Set<ts.Node>} */
  const out = new Set();
  if (!pageIsFixture(sourceFile)) return out;
  const expects = expectBindings(sourceFile);
  visit(sourceFile, (node) => {
    if (
      !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      return;
    }
    const call = node.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node)
      return;
    const callee = call.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'page' ||
      !LOCATOR_METHODS.has(callee.name.text)
    ) {
      return;
    }
    // The locator must be the receiver of an action: page.locator(x).click().
    const access = call.parent;
    if (
      !access ||
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== call ||
      !access.parent ||
      !ts.isCallExpression(access.parent)
    ) {
      return;
    }
    for (let n = call.parent; n && !isStatementNode(n); n = n.parent) {
      if (ts.isVariableDeclaration(n)) return;
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        expects.has(n.expression.text)
      ) {
        return;
      }
    }
    out.add(node);
  });
  return out;
}

/**
 * A node that is itself one statement of a block or file.
 * @param {ts.Node} node
 */
export function isStatementNode(node) {
  const p = node.parent;
  return Boolean(
    p &&
    (ts.isBlock(p) ||
      ts.isSourceFile(p) ||
      ts.isModuleBlock(p) ||
      ts.isCaseClause(p) ||
      ts.isDefaultClause(p))
  );
}

/**
 * The statement a node belongs to (the node itself when it is one).
 * @param {ts.Node} node
 */
export function statementOf(node) {
  let n = node;
  while (n && !isStatementNode(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

/**
 * Canonical text of a node: kinds, identifiers and literal values only — no
 * positions, whitespace or comments. `mask(node)` may replace a node with a
 * placeholder (used for the one editable position).
 * @param {ts.Node} node
 * @param {(node: ts.Node) => boolean} [mask]
 * @returns {string}
 */
export function canonical(node, mask = () => false) {
  if (mask(node)) return '<LOCATOR>';
  const kind = ts.SyntaxKind[node.kind];
  let leaf = '';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) leaf = node.text;
  else if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    leaf = JSON.stringify(node.text);
  }
  /** @type {string[]} */
  const kids = [];
  ts.forEachChild(node, (child) => {
    kids.push(canonical(child, mask));
  });
  return `${kind}${leaf ? `:${leaf}` : ''}${kids.length ? `(${kids.join(',')})` : ''}`;
}

/**
 * Direct children of a node, in order.
 * @param {ts.Node} node
 */
export function childrenOf(node) {
  /** @type {ts.Node[]} */
  const out = [];
  ts.forEachChild(node, (c) => {
    out.push(c);
  });
  return out;
}

/**
 * Depth-first visit of every node.
 * @param {ts.Node} node
 * @param {(node: ts.Node) => void} fn
 */
export function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/**
 * Every traceability id in the file, comments included.
 * @param {string} text
 */
export function traceIds(text) {
  return new Set(text.match(TRACE_ID) ?? []);
}

// ------------------------------------------------------- per-test identity

/** The id kinds each generated test must carry (docs/traceability.md). */
export const TEST_ID_KINDS = ['PW', 'TC', 'SPEC'];

const idsIn = (/** @type {string} */ text, /** @type {string} */ kind) => [
  ...new Set(String(text).match(new RegExp(`\\b${kind}-\\d+\\b`, 'g')) ?? []),
];

/** @param {ts.Node | undefined} node */
function staticString(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/**
 * `{ type, description }` entries of a test's `annotation` option.
 * @param {ts.CallExpression} call
 */
function annotationsOf(call) {
  const opts = call.arguments.find(ts.isObjectLiteralExpression);
  if (!opts) return [];
  const prop = opts.properties
    .filter(ts.isPropertyAssignment)
    .find((p) => ts.isIdentifier(p.name) && p.name.text === 'annotation');
  if (!prop) return [];
  /** @type {readonly ts.Expression[]} */
  const items = ts.isArrayLiteralExpression(prop.initializer)
    ? prop.initializer.elements
    : [prop.initializer];
  return items.filter(ts.isObjectLiteralExpression).map((o) => {
    const get = (/** @type {string} */ key) => {
      const p = o.properties
        .filter(ts.isPropertyAssignment)
        .find((q) => ts.isIdentifier(q.name) && q.name.text === key);
      return p ? staticString(p.initializer) : null;
    };
    return { type: get('type'), description: get('description') };
  });
}

/**
 * Titles of the describe groups enclosing a registration, outermost first.
 * @param {ts.CallExpression} call
 * @param {Set<string>} bindings
 */
function describePath(call, bindings) {
  /** @type {string[]} */
  const path = [];
  for (let n = call.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isCallExpression(n)) {
      const chain = memberChain(n.expression);
      if (chain && bindings.has(chain[0]) && chain.includes('describe')) {
        path.unshift(staticString(n.arguments[0]) ?? '(dynamic)');
      }
    }
  }
  return path;
}

/**
 * The traceability ids each test declares, by source:
 *   - `annotation`: the Playwright `annotation` option ({ type, description });
 *   - `title`: the test title, including the titles of enclosing describes —
 *     what execution reports carry and the ledger links by;
 *   - `comment`: comments immediately attached above the test (legacy).
 * File-level comments that are not attached to a test give it nothing.
 *
 * @returns {{title: string|null, titlePath: string[], line: number,
 *   dynamic: boolean, ids: Record<string, {annotation: string[],
 *   title: string[], comment: string[]}>}[]}
 * @param {ts.SourceFile} sourceFile
 */
export function testIdentities(sourceFile) {
  const text = sourceFile.getFullText();
  const bindings = testBindings(sourceFile);
  return testRegistrations(sourceFile)
    .filter((r) => r.kind === 'test')
    .map((r) => {
      const call = r.node;
      const groups = describePath(call, bindings);
      const titleText = [...groups, r.title ?? ''].join(' > ');
      const statement = statementOf(call);
      const comments = (
        ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []
      )
        .map((c) => text.slice(c.pos, c.end))
        .join('\n');
      const annotations = annotationsOf(call);
      /** @type {Record<string, {annotation: string[], title: string[], comment: string[]}>} */
      const ids = {};
      for (const kind of TEST_ID_KINDS) {
        ids[kind] = {
          annotation: [
            ...new Set(
              annotations
                .filter((a) => a.type === kind)
                .flatMap((a) => idsIn(a.description ?? '', kind))
            ),
          ],
          title: idsIn(titleText, kind),
          comment: idsIn(comments, kind),
        };
      }
      return {
        title: r.title,
        titlePath: [...groups, r.title ?? '(dynamic title)'],
        line: r.line,
        dynamic: r.dynamic,
        ids,
      };
    });
}

export { ts };
