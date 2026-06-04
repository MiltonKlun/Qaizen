import playwright from 'eslint-plugin-playwright';

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
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/missing-playwright-await': 'error',
    },
  },
];
