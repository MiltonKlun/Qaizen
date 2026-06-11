# Planner Brief — DEMO-1 (demo fixture)

> Adapter brief the Test Designer hands the Playwright Planner. In the demo
> this is a replayed fixture; in a real run the Planner explores the live app
> via Playwright MCP before writing the spec (CLAUDE.md §3.8).

## Story

DEMO-1 — User can log in and see the product inventory (`story.md`).

## App under test

The local demo app served at `BASE_URL` (a single static page; the demo
driver starts the server). Stable test hooks are present as `data-test`
attributes: `username`, `password`, `login-button`, `error`, `title`,
`inventory-list`, `item`, `logout-button`.

## In scope (approved `automate_e2e` cases)

- **TC-001 (P0)** — Valid login (`demo` / `demo123`) shows the inventory:
  heading "Products" + at least one product.
- **TC-002 (P1)** — Invalid password keeps the user on the form with the
  error message **exactly** "Invalid credentials" (business copy contract,
  RISK-002 high).

## Out of scope for the Planner

- **TC-003** is `manual` (visual judgment) — do not automate it.
- **Logout / AC-3 (RISK-003)** has no approved test case in this run — do
  not explore it. The release report surfaces it as an uncovered risk; that
  is a deliberate demonstration of coverage-gap reporting.
- Anything beyond the login page and the inventory list (there is nothing
  else in the demo app, and pre-existing behavior is never in scope).

## Traceability

Spec scenarios must reference their TC ids (`TC-001`, `TC-002`); the spec is
`SPEC-001` and the generated tests carry `PW-001` / `PW-002`.
