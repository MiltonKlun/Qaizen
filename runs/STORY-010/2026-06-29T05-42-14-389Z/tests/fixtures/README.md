# Fixtures

Fixtures are app-specific and are deferred until they are actually
needed. In Phase 1 this folder is a placeholder so the directory
layout is stable.

When fixtures become necessary:

- Create `tests/fixtures.ts` with custom Playwright fixtures.
- Document each fixture in this README (name, purpose, how to use,
  any test-data requirements).

## Why deferred

`tests/seed.spec.ts` is auth-free — it only loads `BASE_URL` and
checks the page title. No fixture is needed for the seed.

Phase 2 may introduce auth-aware fixtures alongside the GitHub
Actions work, using Playwright's `storageState` pattern. See
`docs/seed-test-guidelines.md` section 6 for the reasoning behind
the deferral and the conditions that would trigger fixture work.
