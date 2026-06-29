import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/',
      'reports/',
      'playwright-report/',
      'test-results/',
      'traces/',
      '.claude/',
    ],
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
