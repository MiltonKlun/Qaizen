// @ts-check
// The files a set of source files pulls in through relative imports.
//
// Shared by the Healer (which copies exactly these files into its workspace)
// and the Gate 4 binding (which digests them): a page object or helper a test
// imports is part of what the test does, so both must see it.
//
// Only relative specifiers are followed. Package imports resolve through
// package.json and the lockfile, which callers bind on their own.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { parseTestSource, ts, visit } from './test-source.js';

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

const posix = (/** @type {string} */ p) => p.split(sep).join('/');

/**
 * Relative module specifiers a source file imports (static, dynamic, re-export).
 * @param {string} text
 * @param {string} fileName
 * @returns {string[]}
 */
function relativeImports(text, fileName) {
  const parsed = parseTestSource(text, fileName);
  if (!parsed.ok) return [];
  /** @type {string[]} */
  const specs = [];
  visit(parsed.sourceFile, (/** @type {import('typescript').Node} */ n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      specs.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      specs.push(n.arguments[0].text);
    }
  });
  return specs.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** @param {string} p */
function isDirectory(p) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string | null}
 */
function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const tries = [
    base,
    ...CODE_EXT.map((e) => base + e),
    ...CODE_EXT.map((e) => join(base, `index${e}`)),
  ];
  // `./x.js` written for a TS source compiled on the fly.
  if (extname(base) === '.js') tries.push(base.slice(0, -3) + '.ts');
  return tries.find((p) => existsSync(p) && !isDirectory(p)) ?? null;
}

/**
 * The entry files and everything they import relatively, transitively, as
 * repository-relative POSIX paths in the order found. A file outside the
 * repository or named like an environment file is never included; it and any
 * import that cannot be resolved are reported as problems instead.
 * @param {string} root
 * @param {string[]} entries repository-relative paths
 * @returns {{ files: string[], problems: string[] }}
 */
export function importClosure(root, entries) {
  const rootAbs = resolve(root);
  /** @type {Set<string>} */
  const wanted = new Set();
  const queue = entries.map((e) => resolve(rootAbs, e));
  /** @type {string[]} */
  const problems = [];
  for (let abs = queue.shift(); abs !== undefined; abs = queue.shift()) {
    const rel = relative(rootAbs, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      problems.push(`${abs} is outside the repository`);
      continue;
    }
    if (/^\.env/.test(basename(abs))) {
      problems.push(
        `${rel} looks like an environment file and is never copied`
      );
      continue;
    }
    if (wanted.has(rel)) continue;
    if (!existsSync(abs) || isDirectory(abs)) {
      problems.push(`${posix(rel)} does not exist`);
      continue;
    }
    wanted.add(rel);
    for (const spec of relativeImports(readFileSync(abs, 'utf8'), abs)) {
      const target = resolveModule(abs, spec);
      if (target) queue.push(target);
      else problems.push(`${rel} imports ${spec}, which cannot be resolved`);
    }
  }
  return { files: [...wanted].map(posix), problems };
}
