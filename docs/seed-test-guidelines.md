# Seed Test Guidelines

> **Status:** Phase 1 baseline. `tests/seed.spec.ts` was scaffolded by
> `npx playwright init-agents --loop=claude` in Task Group 3 and will be
> replaced with the BASE_URL-aware seed described below in Task Group 11
> of Phase 1. The fixtures area (`tests/fixtures/`) is a placeholder
> in Phase 1 and is filled in when an app actually needs custom
> fixtures.

This document describes the role of `tests/seed.spec.ts` in the
pipeline, how the Playwright Planner Native Agent uses it, and why
fixtures are deferred.

---

## 1. What the seed test is

A single Playwright test (`tests/seed.spec.ts`) that:

- Loads `BASE_URL` from the environment.
- Navigates to it.
- Asserts the page produced a non-empty `<title>`.

That's it. The seed test is not a business test. It does not log in,
exercise features, or check any acceptance criterion.

```ts
// tests/seed.spec.ts (Phase 1 TG11 target content)
import { test, expect } from '@playwright/test';

/**
 * Seed test — used by the Playwright Planner Native Agent as a known
 * starting point. Does not test business logic. Only confirms the app
 * loads at BASE_URL.
 */
test.describe('Seed: Environment Setup', () => {
  test('app loads at BASE_URL', async ({ page }) => {
    const baseURL = process.env.BASE_URL;
    if (!baseURL) {
      throw new Error('BASE_URL env var not set');
    }
    await page.goto(baseURL);
    // Non-business assertion: the page has a title.
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
```

The currently-on-disk seed (auto-scaffolded by `init-agents` in TG3)
is a stub with no assertion. TG11 replaces it with the version above.
Until then there is a benign lint warning (`playwright/expect-expect`).

---

## 2. Why the seed exists

The seed test serves three purposes:

1. **Environment smoke check.** Running it confirms `BASE_URL` is
   set, the application is reachable, Playwright is installed
   correctly, and the browser launches. This catches setup problems
   immediately, before they masquerade as test failures in the real
   suite.
2. **Starting point for the Planner.** The Playwright Planner Native
   Agent uses the seed as the canonical "known good state" from which
   to explore the application. The Planner reads
   `planner-input/[story-id].planner-brief.md` for what to look for
   and drives the app through the `playwright-test` MCP starting from
   the seed's navigation.
3. **Documentation of conventions.** New contributors look at the
   seed to learn the project's test style — what imports look like,
   how `BASE_URL` is handled, how a `test.describe` group is named.

The seed is intentionally minimal because it must remain trustworthy.
A seed that does too much is a seed that can fail for non-environment
reasons, which defeats its purpose.

---

## 3. How the Planner uses the seed

When the Playwright Planner Native Agent
(`.claude/agents/playwright-test-planner.md`) runs at Phase 1 TG13
step 9, it is given:

- `planner-input/[story-id].planner-brief.md` — what to explore and
  what to leave alone.
- `tests/seed.spec.ts` — the starting point.
- `context.json` — for story context and the AC list.

The Planner uses `playwright-test` MCP tools (the
`mcp__playwright-test__*` set; see `docs/mcp-setup.md` and
`docs/ambiguities.md` entry A2 for why the MCP is named
`playwright-test`, not `playwright`) to:

1. Run the seed test to reach the known-good state.
2. From there, drive the app through the in-scope scenarios in the
   brief — clicking, typing, taking accessibility snapshots, etc.
3. Write `specs/[story-id].md` — the Markdown spec consumed at
   Gate 3 and then by the Generator.

The Planner does **not** modify the seed. The seed is an input to
the Planner, not an output.

The Generator does not need the seed at all — it consumes
`specs/[story-id].md` and produces `tests/[story-id].spec.ts`
alongside the existing seed.

---

## 4. What the seed must NOT do

- **No business logic.** No login, no add-to-cart, no AC verification.
  Business logic belongs in the Generator-produced tests, which are
  the artifacts that go through Gate 4.
- **No assertions beyond "page loaded".** A title-length check is
  enough. Avoid `toHaveURL` (which couples the seed to a specific
  landing route) or visual snapshots (which couple it to UI choices).
- **No hard-coded URL.** The seed must read `BASE_URL` from
  `process.env.BASE_URL`. Hardcoding "https://example.com" defeats
  the smoke purpose.
- **No reliance on fixtures.** The seed runs before fixtures exist.
  If the application needs auth to load even the landing page,
  document that and capture an auth strategy — but the seed itself
  stays auth-free in Phase 1. See section 6.

---

## 5. Running the seed

Phase 1 runs the seed locally:

```bash
BASE_URL=https://your-app.com npm run test -- tests/seed.spec.ts
```

In Phase 2 the seed runs as part of the GitHub Actions `playwright-smoke`
job. If the seed fails in CI, it is treated as an environment problem
(stale credentials, app down, BASE_URL misconfigured), not a test
problem — because the seed has no business assertions.

---

## 6. Why fixtures are deferred

`tests/fixtures/` is created in Phase 1 TG1 as a placeholder. Its
`README.md` (Phase 1 TG11) documents that fixtures arrive when the
application actually needs them.

The reasoning:

- **Fixtures are app-specific.** Auth flows, test users, seeded data
  — every app needs its own. Writing fixtures speculatively, before
  there is a concrete need, produces fragile abstractions.
- **Phase 1's seed is auth-free.** It only loads `BASE_URL` and
  checks the title. No fixture needed.
- **When an app needs auth in Phase 2+,** the answer is
  Playwright's `storageState` pattern — see
  https://playwright.dev/docs/auth. The seed is updated to capture
  storage state once; subsequent tests reuse it via fixtures defined
  in `tests/fixtures.ts`.

Until that need actually appears, `tests/fixtures/` stays a
placeholder.

---

## 7. When the seed should change

Three legitimate reasons to modify the seed:

1. **The app's landing experience changed in a way that breaks the
   smoke check** — e.g. the title is now intentionally blank on a
   single-page-app shell. Update the assertion to one that still
   means "the app loaded".
2. **Auth is now required to reach the landing page.** Update the
   seed to call into a `storageState` setup so the Planner has an
   authenticated starting point. This is a Phase 2+ change and
   should land alongside fixture work.
3. **A new browser project is added.** If the project tests on
   Chromium and Firefox in CI, the seed should run on both. This is
   a `playwright.config.ts` change, not a seed change.

Reasons that are NOT legitimate:

- "The seed sometimes fails." Investigate. Hiding it doesn't fix it.
- "I added a TC the seed should cover." TCs go in the Generator's
  output, not the seed. The seed stays minimal.

---

## 8. References

- `docs/review-gates.md` — **Locator selection policy** that the
  Planner and Generator follow when producing test code from the
  seed onward. The policy is "most robust locator wins", not
  "always semantic" — see Gate 4 + the dedicated section.
- `tests/seed.spec.ts` — the actual file. It is tagged `@smoke` as the
  worked example of the test-tagging convention.
- `docs/test-tagging.md` — the `@smoke` / `@regression` tagging convention
  for generated product tests, and the smoke-gating graduation path.
- `tests/fixtures/README.md` — the placeholder note for fixtures
  (created in Phase 1 TG11).
- `.claude/agents/playwright-test-planner.md` — the Native Agent that
  consumes the seed.
- `docs/mcp-setup.md` — the `playwright-test` MCP that backs the
  Native Agents.
- `tests/seed.spec.ts` — the seed test itself.
