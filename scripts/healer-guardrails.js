// @ts-check
// Healer guardrails — the static check on a candidate patch (CLAUDE.md §3.6).
// Shared by the harness (scripts/run-healer.js) and the demo
// (scripts/demo-healer-green-red.js). Pure: no I/O, no side effects.
//
// An earlier regex version
// accepted negated matchers, removed assertions, changed snapshot targets,
// added `.skip` when another skip already existed, and "kept" tests that had
// been commented out. The comparison now parses both files and compares their
// executable structure with positions, whitespace and comments removed:
//
//   - The ONLY automatic edit is a changed static string in
//     `page.locator('...')` / `page.getByTestId('...')`, where `page` is
//     provably the Playwright fixture and the locator is the receiver of an
//     allowed action in a statement of its own (`await page.locator('...')
//     .click();`), outside any assertion; see repairableLocators(). A new
//     `page.locator()` string may not add syntax that widens or moves what it
//     matches (selectorBroadening()). Everything else in the executable code
//     must be identical: test declarations, imports, hooks, control flow,
//     every assertion (target, matcher, modifiers such as `.not`, expected
//     values, `await`), snapshot targets and every other statement.
//   - Test registrations are resolved through the file's imports (aliases
//     included). Adding `.skip`/`.fixme`/`.only`/`.fail`, deleting a test or a
//     hook, or registering tests dynamically is rejected, regardless of what
//     the file already contained.
//   - Traceability ids (TC-/PW-/SPEC-/...) must survive, comments included.
//   - Source that does not parse is rejected with a reason, never guessed at.
//
// A candidate with no violations is ELIGIBLE UNDER STATIC CHECKS, not safe:
// equal structure does not prove that a new selector targets the same
// business element. A human still reviews every patch.

import {
  SUPPRESSION,
  canonical,
  childrenOf,
  expectBindings,
  lineOf,
  parseTestSource,
  repairableLocators,
  statementOf,
  testBindings,
  testRegistrations,
  traceIds,
  ts,
  visit,
} from './lib/test-source.js';

/**
 * @typedef {import('./lib/test-source.js').Registration} Registration
 * @typedef {{ eligible: boolean, violations: string[],
 *   repairs: {line: number, from: string, to: string}[]}} CandidateCheck
 * A differing region: a node of the original (`a`) and of the candidate
 * (`b`); null on the side where it was added or removed.
 * @typedef {{ a: ts.Node | null, b: ts.Node | null }} Region
 * @typedef {{ canonA: (n: ts.Node) => string, canonB: (n: ts.Node) => string,
 *   regions: Region[] }} DiffContext
 * @typedef {{ expect: boolean, matchers: string[] }} CallInfo
 */

/** What a clean result means — for every consumer that prints one. */
export const ELIGIBILITY_NOTE =
  'eligible under static checks; human review still required (equal structure does not prove the new selector targets the same element)';

const SNAPSHOT_MATCHERS = new Set([
  'toHaveScreenshot',
  'toMatchSnapshot',
  'toMatchAriaSnapshot',
]);

/**
 * Matchers that assert almost nothing (a trivially-true form). Shared with
 * the pre-Gate-4 scanner (scripts/gate4-scan.js) so both flag the same set.
 */
export const WEAK_MATCHERS = new Set([
  'toBeTruthy',
  'toBeDefined',
  'toBeFalsy',
]);

/**
 * Compare a candidate with the original test source.
 *
 * @param {string} originalSource
 * @param {string} candidateSource
 * @param {{ fileName?: string }} [opts]
 * @returns {CandidateCheck}
 */
export function checkCandidate(
  originalSource,
  candidateSource,
  { fileName } = {}
) {
  const a = parseTestSource(originalSource, fileName);
  if (!a.ok) {
    return reject([
      `the original is ${a.reason}; nothing can be checked against it`,
    ]);
  }
  const b = parseTestSource(candidateSource, fileName);
  if (!b.ok) return reject([`the candidate is ${b.reason}`]);
  const A = a.sourceFile;
  const B = b.sourceFile;
  /** @type {string[]} */
  const v = [];

  // --- test registrations, resolved through imports -------------------
  const ra = testRegistrations(A);
  const rb = testRegistrations(B);
  if (ra.some((r) => r.dynamic) || rb.some((r) => r.dynamic)) {
    // some() above guarantees a dynamic registration exists.
    const r = /** @type {Registration} */ (
      [...rb, ...ra].find((x) => x.dynamic)
    );
    v.push(
      `registers tests dynamically (line ${r.line}); how many tests exist cannot be checked statically — manual review`
    );
  }
  /** @type {(list: Registration[], pred: (r: Registration) => boolean) => number} */
  const count = (list, pred) => list.filter(pred).length;
  if (
    count(rb, (r) => r.kind === 'test') < count(ra, (r) => r.kind === 'test')
  ) {
    v.push('removes a test (deleting tests is forbidden)');
  }
  if (
    count(rb, (r) => r.kind === 'hook') < count(ra, (r) => r.kind === 'hook')
  ) {
    v.push('removes a hook (setup/teardown must not change)');
  }
  /** @type {Record<string, string>} */
  const SUPPRESSION_REASON = {
    skip: 'adds test suppression (.skip) — forbidden',
    fixme: 'adds test suppression (.fixme) — forbidden',
    only: 'adds a focused test (.only) — forbidden',
    fail: 'adds an expected-failure declaration (.fail) — forbidden',
  };
  for (const s of SUPPRESSION) {
    if (
      count(rb, (r) => r.suppression.includes(s)) >
      count(ra, (r) => r.suppression.includes(s))
    ) {
      v.push(SUPPRESSION_REASON[s]);
    }
  }

  // --- traceability, comments included ---------------------------------
  const kept = traceIds(candidateSource);
  const lost = [...traceIds(originalSource)].filter((id) => !kept.has(id));
  if (lost.length) {
    v.push(`removes traceability reference(s) ${lost.sort().join(', ')}`);
  }

  // --- executable structure, with the one repairable position masked ---
  const maskA = repairableLocators(A);
  const maskB = repairableLocators(B);
  /** @type {DiffContext} */
  const ctx = {
    canonA: memo((n) => canonical(n, (x) => maskA.has(x))),
    canonB: memo((n) => canonical(n, (x) => maskB.has(x))),
    regions: [],
  };
  diff(A, B, ctx);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const region of ctx.regions) {
    const msg = classify(region, A, B);
    if (!seen.has(msg)) {
      seen.add(msg);
      v.push(msg);
    }
  }

  const unique = [...new Set(v)];
  if (unique.length) return reject(unique);

  // Structure equal: list the locator literals that changed.
  // Masked nodes are the string literals repairableLocators() selected.
  /** @type {ts.StringLiteralLike[]} */
  const litsA = [];
  /** @type {ts.StringLiteralLike[]} */
  const litsB = [];
  visit(A, (n) => {
    if (maskA.has(n)) litsA.push(/** @type {ts.StringLiteralLike} */ (n));
  });
  visit(B, (n) => {
    if (maskB.has(n)) litsB.push(/** @type {ts.StringLiteralLike} */ (n));
  });
  const changed = litsA
    .map((n, i) => ({ a: n, b: litsB[i] }))
    .filter(({ a, b }) => a.text !== b.text);
  // A `page.locator()` string is a selector: the new one may not widen what
  // it matches or pick by position. A test id is matched exactly, so a
  // getByTestId string cannot.
  for (const { a, b } of changed) {
    if (locatorMethod(b) !== 'locator') continue;
    for (const what of selectorBroadening(a.text, b.text)) {
      v.push(
        `the repaired selector adds ${what}; it may widen or move what the locator matches (line ${lineOf(b)})`
      );
    }
  }
  if (v.length) return reject(v);
  const repairs = changed.map(({ a, b }) => ({
    line: lineOf(b),
    from: a.text,
    to: b.text,
  }));
  return { eligible: true, violations: [], repairs };
}

/**
 * Compatible entry point for existing callers: [] means eligible under static
 * checks (see ELIGIBILITY_NOTE), anything else lists why it is not.
 * @param {string} originalSource
 * @param {string} patchedSource
 * @param {{ fileName?: string }} [opts]
 */
export function guardrailViolations(originalSource, patchedSource, opts) {
  return checkCandidate(originalSource, patchedSource, opts).violations;
}

/**
 * The locator method a masked literal is the argument of (`locator` or
 * `getByTestId`), or '' when it is neither.
 * @param {ts.Node} literal
 * @returns {string}
 */
function locatorMethod(literal) {
  const call = literal.parent;
  return ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : '';
}

/**
 * @param {string[]} violations
 * @returns {CandidateCheck}
 */
function reject(violations) {
  return { eligible: false, violations, repairs: [] };
}

/**
 * @param {(n: ts.Node) => string} fn
 * @returns {(n: ts.Node) => string}
 */
function memo(fn) {
  /** @type {Map<ts.Node, string>} */
  const cache = new Map();
  return (n) => {
    let value = cache.get(n);
    if (value === undefined) {
      value = fn(n);
      cache.set(n, value);
    }
    return value;
  };
}

// ---------------------------------------------------------------- diff

/**
 * Collect minimal differing regions between two trees.
 * @param {ts.Node} a
 * @param {ts.Node} b
 * @param {DiffContext} ctx
 */
function diff(a, b, ctx) {
  if (ctx.canonA(a) === ctx.canonB(b)) return;
  const ka = childrenOf(a);
  const kb = childrenOf(b);
  if (a.kind !== b.kind || ka.length === 0 || kb.length === 0) {
    ctx.regions.push({ a, b });
    return;
  }
  if (ka.length === kb.length && ka.every((x, i) => x.kind === kb[i].kind)) {
    let found = false;
    ka.forEach((x, i) => {
      if (ctx.canonA(x) !== ctx.canonB(kb[i])) {
        found = true;
        diff(x, kb[i], ctx);
      }
    });
    if (!found) ctx.regions.push({ a, b }); // differs in a leaf value
    return;
  }
  // A different shape inside an expression is one changed region; only a
  // statement list is aligned to find added and removed statements.
  const statementList =
    ts.isBlock(a) ||
    ts.isSourceFile(a) ||
    ts.isModuleBlock(a) ||
    ts.isCaseClause(a) ||
    ts.isDefaultClause(a);
  if (!statementList) {
    ctx.regions.push({ a, b });
    return;
  }
  const sa = ka.map(ctx.canonA);
  const sb = kb.map(ctx.canonB);
  const pairs = lcs(sa, sb);
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [ka.length, kb.length]]) {
    const removed = ka.slice(i, pi);
    const added = kb.slice(j, pj);
    if (removed.length === added.length) {
      removed.forEach((x, k) => diff(x, added[k], ctx));
    } else {
      for (const x of removed) ctx.regions.push({ a: x, b: null });
      for (const y of added) ctx.regions.push({ a: null, b: y });
    }
    i = pi + 1;
    j = pj + 1;
  }
}

/**
 * Index pairs of a longest common subsequence of two string arrays.
 * @param {string[]} x
 * @param {string[]} y
 * @returns {[number, number][]}
 */
function lcs(x, y) {
  const m = x.length;
  const n = y.length;
  /** @type {number[][]} */
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      t[i][j] =
        x[i] === y[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  /** @type {[number, number][]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// ---------------------------------------------------------------- reasons

/**
 * @param {ts.Node | null} node
 * @param {Set<string>} expects
 * @returns {CallInfo}
 */
function callsIn(node, expects) {
  /** @type {CallInfo} */
  const info = { expect: false, matchers: [] };
  if (!node) return info;
  visit(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    let root = n.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) {
      if (ts.isPropertyAccessExpression(root))
        info.matchers.push(root.name.text);
      root = root.expression;
    }
    if (ts.isIdentifier(root) && expects.has(root.text)) info.expect = true;
  });
  return info;
}

/**
 * @param {ts.Node | null} stmt
 * @param {Set<string>} bindings
 */
function isRegistration(stmt, bindings) {
  if (!stmt || !ts.isExpressionStatement(stmt)) return false;
  let e = stmt.expression;
  if (ts.isAwaitExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return false;
  let root = e.expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) && bindings.has(root.text);
}

/**
 * One human-readable reason for a differing region.
 * @param {Region} region
 * @param {ts.SourceFile} A
 * @param {ts.SourceFile} B
 */
function classify({ a, b }, A, B) {
  const expects = new Set([...expectBindings(A), ...expectBindings(B)]);
  const bindings = new Set([...testBindings(A), ...testBindings(B)]);
  const sa = a ? statementOf(a) : null;
  const sb = b ? statementOf(b) : null;
  // A region always has at least one side.
  const where = ` (line ${lineOf(/** @type {ts.Node} */ (sb ?? sa))})`;
  const ia = callsIn(sa, expects);
  const ib = callsIn(sb, expects);
  /** @type {(info: CallInfo, set: Set<string>) => boolean} */
  const has = (info, set) => info.matchers.some((m) => set.has(m));
  const weakCount = (/** @type {CallInfo} */ info) =>
    info.matchers.filter((m) => WEAK_MATCHERS.has(m)).length;

  if (has(ia, SNAPSHOT_MATCHERS) || has(ib, SNAPSHOT_MATCHERS)) {
    return `changes or introduces a snapshot assertion — needs explicit human approval${where}`;
  }
  if (weakCount(ib) > weakCount(ia)) {
    return `weakens an assertion to a trivially-true form (e.g. toBeTruthy)${where}`;
  }
  if (ia.expect || ib.expect) {
    if (!sb) return `removes an assertion${where}`;
    return `changes an assertion (target, matcher, modifier, await or expected value)${where}`;
  }
  if (isRegistration(sa, bindings) || isRegistration(sb, bindings)) {
    return `changes test registration (a test, group or hook)${where}`;
  }
  const changedLocator = [a, b].some(
    (n) =>
      n &&
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      ts.isCallExpression(n.parent) &&
      ts.isPropertyAccessExpression(n.parent.expression) &&
      ['locator', 'getByTestId'].includes(n.parent.expression.name.text)
  );
  if (changedLocator) {
    return `changes a locator that is not eligible for automatic repair (only the receiver of an awaited action statement such as click or fill on the provable page fixture is)${where}`;
  }
  if (!sb) return `removes executable code${where}`;
  if (!sa) return `adds executable code${where}`;
  return `changes executable code outside the allowed locator-literal edit${where}`;
}

// ---------------------------------------------------------------- selectors

/** Stands in for a character inside quotes or brackets (see topLevel). */
const BLANK = '\u0001';

/**
 * The selector with everything inside quotes and brackets blanked, one
 * character for one, so a comma or `>>` inside `[data-test="a,b"]` is not
 * read as syntax and positions still line up with the original string. A
 * backslash escape is blanked with the character it escapes, as Playwright's
 * parser skips it.
 * @param {string} selector
 */
function topLevel(selector) {
  return scanSelector(selector).top;
}

/**
 * Whether every quote and bracket in a selector is closed, and closed in
 * order. An unclosed one hides the rest of the string from the checks below.
 * @param {string} selector
 */
function isBalanced(selector) {
  return scanSelector(selector).balanced;
}

/**
 * @param {string} selector
 * @returns {{ top: string, balanced: boolean }}
 */
function scanSelector(selector) {
  let out = '';
  let depth = 0;
  let balanced = true;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') {
      out += BLANK;
      if (i + 1 < selector.length) {
        out += BLANK;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      out += BLANK;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += BLANK;
    } else if (c === '[' || c === '(') {
      depth++;
      out += depth === 1 ? c : BLANK;
    } else if (c === ']' || c === ')') {
      if (depth === 0) balanced = false;
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? c : BLANK;
    } else {
      out += depth === 0 ? c : BLANK;
    }
  }
  return { top: out, balanced: balanced && depth === 0 && quote === null };
}

/**
 * The `>>`-separated parts of a selector, split only where `>>` is syntax.
 * @param {string} selector
 */
function selectorParts(selector) {
  const top = topLevel(selector);
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  for (let i = top.indexOf('>>'); i !== -1; i = top.indexOf('>>', i + 2)) {
    parts.push(selector.slice(start, i).trim());
    start = i + 2;
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

/** @type {(s: string, re: RegExp) => number} */
const occurrences = (s, re) => (s.match(re) ?? []).length;

/**
 * A matched text in a comparable form: quotes and a trailing `i`/`s` flag
 * removed, case folded.
 * @param {string} raw
 */
function normalText(raw) {
  let t = raw.trim();
  const quoted = /^(["'`])([\s\S]*)\1[is]?$/.exec(t);
  if (quoted) t = quoted[2];
  return t.trim().toLowerCase();
}

/**
 * The texts a selector matches by: text engines (`text=`, `internal:text=`,
 * `internal:has-text=`, ...), legacy quoted parts, and the arguments of
 * `:has-text()`, `:text()`, `:text-is()` and `:text-matches()`.
 * @param {string} selector
 * @returns {string[]}
 */
function selectorTexts(selector) {
  /** @type {string[]} */
  const texts = [];
  for (const part of selectorParts(selector)) {
    const engine = /^(?:internal:)?[a-z-]*text[a-z-]*=([\s\S]*)$/i.exec(part);
    if (engine) texts.push(normalText(engine[1]));
    else if (/^["'][\s\S]*["'][is]?$/.test(part)) texts.push(normalText(part));
  }
  const pseudo =
    /:(?:has-text|has-not-text|text|text-is|text-matches)\(\s*(?:(["'])([\s\S]*?)\1|([^)]*))/gi;
  for (const m of selector.matchAll(pseudo)) {
    texts.push(normalText(m[2] ?? m[3] ?? ''));
  }
  return texts;
}

/**
 * Whether a selector part is XPath: an `xpath=` engine, or a part Playwright
 * reads as XPath because it starts with `/`, `..` or `(`.
 * @param {string} part
 */
const isXPath = (part) => /^(?:xpath=|\/|\.\.|\()/i.test(part.trim());

/**
 * The engine a selector part names (`text`, `role`, `internal:label`, ...),
 * lower-cased; empty for a plain CSS part or an explicit `css=`.
 * @param {string} part
 * @returns {string}
 */
function engineOf(part) {
  const name = /^([a-z][a-z0-9_:-]*)=/i.exec(part.trim())?.[1].toLowerCase();
  return !name || name === 'css' ? '' : name;
}

const WHOLE_PAGE = new Set(['body', 'html', ':root', ':scope', '*']);

/**
 * Whether a CSS selector part's subject (its last compound) is the whole
 * page: `body`, `html`, `:root`, `:scope` or `*`, alone or qualified
 * (`html > body`, `body:not(.x)`).
 * @param {string} part
 */
function cssSubjectIsPage(part) {
  const top = topLevel(part.replace(/^css=/i, '')).toLowerCase();
  const compounds = top.split(/[\s>+~]+/).filter(Boolean);
  const last = compounds.at(-1) ?? '';
  const head = /^(?:\*|[a-z][a-z0-9-]*|:root|:scope)/.exec(last)?.[0] ?? '';
  return WHOLE_PAGE.has(head);
}

/**
 * Whether an XPath part's last step is the whole page (`/html`, `//body`,
 * `/*`, `.`).
 * @param {string} part
 */
function xpathSubjectIsPage(part) {
  const path = part
    .trim()
    .replace(/^xpath=/i, '')
    .trim()
    .toLowerCase();
  if (path === '.' || path === '/') return true;
  const step = path.split('/').at(-1) ?? '';
  return ['body', 'html', '*'].includes(step.trim());
}

/**
 * Selector syntax a repaired `page.locator()` string may not add, because it
 * widens what the locator matches or picks an element by position: `>>`
 * chains, `nth=`, positional pseudo-classes (`:nth-*`, `:first-*`,
 * `:last-*`, `:only-*`), `:is()` and `:where()`, top-level unions (`,` or
 * `|`), escapes, XPath (and in XPath any new predicate, group or union),
 * text matching with text the original did not use, and a subject that is
 * the whole page (`body`, `html`, `:root`, `:scope`, `*`). Only what the
 * candidate adds counts; syntax the original already had may stay. Pseudo-
 * classes and engines are matched without regard to case, as Playwright
 * reads them.
 * @param {string} from the original selector
 * @param {string} to the candidate selector
 * @returns {string[]} what was added, empty when nothing was
 */
export function selectorBroadening(from, to) {
  /** @type {string[]} */
  const added = [];
  const a = topLevel(from).toLowerCase();
  const b = topLevel(to).toLowerCase();
  /** @type {[RegExp, string][]} */
  const SYNTAX = [
    [/>>/g, 'a chained selector (>>)'],
    [/\bnth=/g, 'a positional selector (nth=)'],
    [/:(?:nth|first|last|only)-[a-z-]+/g, 'a positional pseudo-class'],
    [/:is\(/g, 'a selector list (:is())'],
    [/:where\(/g, 'a selector list (:where())'],
    [/:not\(/g, 'a negation (:not())'],
    [/,/g, 'a selector union (,)'],
    [/\|(?!=)/g, 'a selector union (|)'],
  ];
  for (const [re, what] of SYNTAX) {
    if (occurrences(b, re) > occurrences(a, re)) added.push(what);
  }
  if (occurrences(to, /\\/g) > occurrences(from, /\\/g)) {
    added.push('an escape (\\)');
  }

  if (!isBalanced(to) && isBalanced(from)) {
    added.push('an unclosed quote or bracket');
  }

  const partsA = selectorParts(from);
  const partsB = selectorParts(to);
  const enginesA = new Set(partsA.map(engineOf));
  const newEngines = [
    ...new Set(partsB.map(engineOf).filter((e) => e && !enginesA.has(e))),
  ];
  if (newEngines.length) {
    added.push(
      `a selector engine the original did not use (${newEngines.join(', ')})`
    );
  }
  const xA = partsA.filter(isXPath);
  const xB = partsB.filter(isXPath);
  if (xB.length > xA.length) {
    added.push('an XPath selector');
  } else if (xB.length) {
    // In XPath, `[...]` is a predicate (often a position), `(...)` a group
    // and `|` a union, wherever they sit.
    const count = (/** @type {string[]} */ xs, /** @type {RegExp} */ re) =>
      xs.reduce((n, x) => n + occurrences(x, re), 0);
    if (count(xB, /[[(|]/g) > count(xA, /[[(|]/g)) {
      added.push('an XPath predicate, group or union');
    }
  }

  const known = new Set(selectorTexts(from));
  if (selectorTexts(to).some((t) => !known.has(t))) {
    added.push('text matching on text the original did not use');
  }

  const subject = partsB.at(-1) ?? '';
  const pageA = (() => {
    const s = partsA.at(-1) ?? '';
    return isXPath(s) ? xpathSubjectIsPage(s) : cssSubjectIsPage(s);
  })();
  const pageB = isXPath(subject)
    ? xpathSubjectIsPage(subject)
    : cssSubjectIsPage(subject);
  if (pageB && !pageA) added.push(`the whole page (${to.trim()})`);
  return added;
}
