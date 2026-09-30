import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

// Globals are declared here, not pulled from a package: the runtime code is
// plain Node ESM (scripts, tests, example servers, benchmark probes), and the
// two example apps run in a browser (task group 10.1).
const readonly = (names) =>
  Object.fromEntries(names.map((name) => [name, 'readonly']));
const NODE_GLOBALS = readonly([
  'AbortController',
  'AbortSignal',
  'Blob',
  'Buffer',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'fetch',
  'globalThis',
  'performance',
  'process',
  'queueMicrotask',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',
]);
const BROWSER_GLOBALS = readonly([
  'console',
  'document',
  'globalThis',
  'location',
  'sessionStorage',
  'window',
]);

// Core rules that catch real defects in untyped JavaScript. Each is on for all
// runtime code; an intentional exception is made inline, with its reason,
// never by switching a rule off here.
const CORE_RULES = {
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-constant-condition': 'error',
  'no-control-regex': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty': 'error',
  'no-empty-pattern': 'error',
  'no-fallthrough': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-loss-of-precision': 'error',
  'no-prototype-builtins': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-setter-return': 'error',
  'no-sparse-arrays': 'error',
  'no-undef': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-private-class-members': 'error',
  'no-unused-vars': 'error',
  'no-useless-catch': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  {
    ignores: [
      'node_modules/',
      'reports/',
      'playwright-report/',
      'test-results/',
      'traces/',
      '.claude/',
      'runs/',
      '.tmp-*/',
    ],
  },
  {
    files: [
      'scripts/**/*.js',
      'test/**/*.js',
      'examples/**/serve.js',
      'examples/shared/**/*.js',
      'examples/**/*.probe.mjs',
      '*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: CORE_RULES,
  },
  {
    // Browser scripts of the example apps (classic scripts, not modules).
    files: ['examples/**/app/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: CORE_RULES,
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    // The TypeScript parser is required so ESLint can read the type syntax
    // (type imports, parameter annotations) that strict-mode tests use — the
    // Generator emits typed tests, and tsconfig `strict: true` requires the
    // annotations. Without this, ESLint's default parser fails on any TS token.
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      ...playwright.configs['flat/recommended'].plugins,
    },
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/missing-playwright-await': 'error',
    },
  },
];
