# Planner Brief — STORY-003: Cart badge shows stale item count after removing an item

## Story summary

A regression fix. After a refactor cached the cart badge count, removing an item
left the header showing a stale (pre-removal) count until the next navigation.
The badge must decrement immediately on remove, disappear when the cart empties,
and stay correct across navigation — without depending on a reload to self-correct.

## Acceptance criteria

1. Remove one item on the cart page → header badge updates to N-1 without a page reload.
2. Remove the last item → header badge is hidden entirely (not shown as "0").
3. After a remove, navigate away and back → badge still shows the correct count.

## Risks (anchors)

- **RISK-001** (high): badge shows a stale count after a remove until a reload. Related ACs: [1, 3].
- **RISK-002** (medium): at empty cart the badge shows "0" / stays visible instead of disappearing. Related ACs: [2].

## In-scope scenarios for the Playwright Planner

- **TC-001 (RISK-001, P0):** remove one item → badge decrements **in-place, no reload**. THE regression case.
- **TC-002 (RISK-002, P1):** remove last item → badge **absent** (assert not-present, not text "0").
- **TC-003 (RISK-001, P2):** assert correct count **in-place first**, THEN navigate away and back and re-assert.

## Out-of-scope for the Planner

- Adding items beyond the precondition setup (the increment path already works — do not write add-path ACs).
- Cart total price recomputation (separate story).
- Cart persistence across logout/login sessions.
- Visual styling of the badge.
- Checkout / payment flow — do NOT navigate into checkout.

## UI baseline notes (to confirm by exploring the running app)

- App https://www.saucedemo.com; user standard_user / secret_sauce.
- Items are added from the inventory page; the cart page (cart link in the header)
  has a Remove button per line item. The header badge shows the count and is
  expected to be ABSENT when the cart is empty. **Confirm the real remove flow,
  the badge element, and the empty-state behavior by exploring before writing.**

## Critical scope note for TC-003 (do not skip)

The documented bug "self-corrects" on reload/navigation. So a test that ONLY
navigates-then-checks would pass even on the buggy app. TC-003 must assert the
count **in-place, before** any navigation, and only then do the round-trip — so
the test genuinely pins the regression rather than being masked by it.

## Ambiguities still open

None blocking. (No server-side cart API; the badge is client-rendered, so the
whole story is E2E by necessity — a Test Designer note, not an ambiguity.)

## Traceability

- Story: STORY-003
- Risks covered: RISK-001, RISK-002
