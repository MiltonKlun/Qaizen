import { test, expect } from '@playwright/test';

/**
 * Seed test: used by the Playwright Planner Native Agent as a known
 * starting point. Does not test business logic — only confirms the
 * application loads at BASE_URL.
 *
 * Rules (see docs/seed-test-guidelines.md):
 *   - No business assertions.
 *   - No hardcoded URL.
 *   - No fixtures.
 *   - One assertion: the page produced a non-empty <title>.
 *
 * The Playwright Planner consumes this file alongside
 * planner-input/[story-id].planner-brief.md to anchor its
 * exploration of the application.
 *
 * The BASE_URL check uses test.skip() (not a module-level throw) so
 * the file loads cleanly when introspected by tooling that doesn't
 * set BASE_URL — e.g. the playwright-test MCP server. A missing
 * BASE_URL skips the test with a clear reason; a real run sets it
 * and the test executes normally.
 */
test.describe('Seed: Environment Setup', () => {
  test('app loads at BASE_URL', async ({ page }) => {
    const baseURL = process.env.BASE_URL ?? '';
    // eslint-disable-next-line playwright/no-skipped-test -- environmental skip with explicit reason, not a hidden failure
    test.skip(baseURL === '', 'BASE_URL env var not set');
    await page.goto(baseURL);
    // Non-business assertion: the page has a title.
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});

// TODO Phase 2+: if the app under test requires auth even to reach
// the landing page, capture storageState here and have downstream
// tests reuse it via fixtures defined in tests/fixtures.ts.
// See https://playwright.dev/docs/auth.
