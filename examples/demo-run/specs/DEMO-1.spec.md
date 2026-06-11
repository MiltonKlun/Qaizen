# SPEC-001 — DEMO-1 Login (demo fixture)

> Playwright Planner spec for DEMO-1. In the demo this is a replayed fixture
> (the demo app's behavior was observed, not invented — the bug against AC-2
> is real and the spec records the AGREED behavior the test must assert).
> Traceability: SPEC-001 → TC-001, TC-002 (RISK-001, RISK-002).

## Scenario 1 — Valid login shows the inventory `[TC-001]`

1. Navigate to `BASE_URL`.
2. Fill `[data-test='username']` with `demo` and `[data-test='password']`
   with `demo123`.
3. Click `[data-test='login-button']`.

**Expected (business behavior):**

- The inventory section is visible, with the heading "Products"
  (`[data-test='title']`).
- The product list (`[data-test='item']`) contains at least one product.

## Scenario 2 — Invalid password shows the agreed error copy `[TC-002]`

1. Navigate to `BASE_URL`.
2. Fill `[data-test='username']` with `demo` and `[data-test='password']`
   with `nope`.
3. Click `[data-test='login-button']`.

**Expected (business behavior):**

- The user remains on the login form.
- The error message (`[data-test='error']`) reads **exactly**
  `Invalid credentials` — the copy agreed with support (AC-2). The exact
  string is the assertion target; "any error appeared" is not enough.

## Negative-space notes

- Logout (AC-3) is intentionally NOT covered in this run — see the planner
  brief; the release report must show RISK-003 as uncovered.
- Locators use the `data-test` hooks (stable test contracts, preferred per
  the locator policy in `docs/review-gates.md`).
