# Planner Brief — STORY-010: Cart badge reflects item count on the inventory page

## Story summary

A signed-in shopper on the SauceDemo inventory page can add and remove
products. The cart badge on the top navigation must always show the
current number of distinct items in the cart — appearing on the first
add, decrementing on remove, disappearing at empty, and surviving
navigation to the cart page and back.

## Acceptance criteria

1. Empty cart + add one product → badge appears showing "1".
2. Two distinct products added → badge shows "2".
3. Remove decrements the badge; badge disappears when cart returns to empty.
4. Navigating cart page → back to inventory preserves the badge count.

## Risks (anchors)

- **RISK-001** (high): Badge shows a stale/incorrect count after an add. Related ACs: [1, 2].
- **RISK-002** (high): Remove does not decrement, or badge fails to disappear at empty (phantom item). Related ACs: [3].
- **RISK-003** (medium): Cart count lost when navigating between cart and inventory pages. Related ACs: [4].

## In-scope scenarios for the Playwright Planner

- **Add one → badge shows 1** (TC-001, RISK-001) — primary happy path.
- **Add two distinct → badge shows 2** (TC-002, RISK-001) — count arithmetic.
- **Remove decrements; empty hides badge** (TC-003, RISK-002) — includes the
  negative/absence assertion (badge NOT visible at empty).
- **Navigate to cart and back preserves count** (TC-004, RISK-003).

## Out-of-scope for the Planner

- Checkout, payment, order confirmation. Do NOT navigate into the checkout flow.
- Quantity-per-line-item (SauceDemo holds one of each; badge counts distinct items).
- Cart persistence across full logout/login.
- Visual styling of the badge (color, position, font).
- The login flow itself beyond the precondition sign-in — do not write login ACs here.

## UI baseline notes (if available)

- App: https://www.saucedemo.com. User: standard_user / secret_sauce.
- Inventory page shows products with per-product 'Add to cart' / 'Remove' buttons.
- The cart badge is a small numeric superscript on the cart icon; it is absent
  when the cart is empty (this absence is the assertion in TC-003 / AC 3).

## Ambiguities still open

None blocking. (SauceDemo has no separate cart API, so the whole story is
E2E by necessity — recorded as a Test Designer note, not an ambiguity.)

## Traceability

- Story: STORY-010
- Risks covered: RISK-001, RISK-002, RISK-003
