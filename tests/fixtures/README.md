# Fixtures

Fixtures are app-specific and are added only when a test needs one.
`accessibility.ts` (axe checks, `expectAccessible`) is the first.

When fixtures become necessary:

- Create them in this folder, e.g. `tests/fixtures/auth.ts` (as
  `tests/fixtures/accessibility.ts` does). Gate 4 binds this folder, so an
  approved test cannot change behavior through a fixture edited later; a
  file outside it, such as `tests/fixtures.ts`, would not be bound.
- Document each fixture in this README (name, purpose, how to use,
  any test-data requirements).

## Why deferred

`tests/seed.spec.ts` is auth-free — it only loads `BASE_URL` and
checks the page title. No fixture is needed for the seed.

Auth-aware fixtures may come later, using Playwright's
`storageState` pattern. See
`docs/seed-test-guidelines.md` section 6 for the reasoning behind
the deferral and the conditions that would trigger fixture work.
