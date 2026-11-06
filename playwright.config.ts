import { defineConfig } from '@playwright/test';

// In CI a test gets one retry, and a test that passes only on its retry fails
// the run instead of reading as green (docs/security-and-data-safety.md §4).
// Locally a run is a single attempt, as before.
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // Traces and failure screenshots land here; the runner records this path
  // in context.json artifact_paths.traces and .screenshots.
  outputDir: 'reports/test-results',
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  reporter: [
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.BASE_URL,
    // In CI every attempt is traced and the traces of a failing test are
    // kept, its retry included. Traces can hold what a test typed, so CI
    // never uploads them, nor the HTML report that embeds them.
    trace: CI ? 'retain-on-failure-and-retries' : 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
