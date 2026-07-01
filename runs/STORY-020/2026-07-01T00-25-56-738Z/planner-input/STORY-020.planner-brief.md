# Planner Brief — STORY-020: Checkout order summary shows the correct item total, tax, and total

## Story summary

A shopper completes the two-step SauceDemo checkout: enter information (name +
postal code), review the order summary, and finish. The order-summary step must
show a correct Item Total (sum of the cart items' unit prices), a Tax, and a
Total (Item Total + Tax) — so the amount shown before committing is accurate and
internally consistent.

## Acceptance criteria

1. Valid info submitted → reach Checkout: Overview showing both items.
2. Item Total = exact sum of the cart items' unit prices.
3. Total = displayed Item Total + displayed Tax (on-screen math is consistent).
4. Missing required field → stay on Information step with an error (no advance).
5. Finish → Checkout: Complete! confirmation AND the cart badge is cleared.

## Risks (anchors)

- **RISK-001** (high): wrong Item Total (not the sum). Related ACs: [2].
- **RISK-002** (high): Total not consistent with Item Total + Tax. Related ACs: [3].
- **RISK-003** (medium): form advances despite a missing required field. Related ACs: [4].
- **RISK-004** (medium): Finish does not confirm / does not clear the cart. Related ACs: [1, 5].

## In-scope scenarios for the Playwright Planner

- **TC-001 (RISK-004, P0):** cart → Checkout → fill valid info → Continue → reach Overview with both items.
- **TC-002 (RISK-001, P0):** on Overview, **read the live unit prices and the rendered Item Total; assert Item Total = sum**. Money-math — regression critical.
- **TC-003 (RISK-002, P0):** on Overview, **read the rendered Item Total, Tax, Total; assert Total = Item Total + Tax** (to the cent). Money-math.
- **TC-004 (RISK-003, P1):** on Information, leave Postal Code empty → Continue → error shown, still on Information (negative case).
- **TC-005 (RISK-004, P1):** Finish → Checkout: Complete! reached AND cart badge absent.

## Critical scope note for the money-math cases (do not skip)

TC-002 and TC-003 must be grounded in **live rendered values**. Read the actual
prices, tax, and total from the page and assert their arithmetic relationships.
Do NOT hard-code a magic number (e.g. "$39.98") from the story text — prices can
change, and a hard-coded expectation would make the test a fiction that passes
by luck, not by verifying the app's math. Read; compute; compare.

## Out-of-scope for the Planner

- Adding/removing items inside the checkout flow (cart contents are a precondition, set up before checkout).
- Real payment processing (SauceDemo has no payment backend).
- Order-history persistence across sessions.
- Visual styling of the checkout pages.
- The Cancel buttons' navigation targets.

## UI baseline notes (to confirm by exploring the running app)

- App https://www.saucedemo.com; user standard_user / secret_sauce.
- Flow: inventory → add items → cart (cart link) → Checkout → Your Information
  (First Name / Last Name / Zip-Postal Code, Continue) → Overview (item list +
  'Item total:', 'Tax:', 'Total:' summary + Finish) → Complete!. **Confirm the
  real field labels, the summary line formats, and the error-message behavior by
  exploring before writing.**

## Ambiguities still open

None blocking. (No order-summary API; the summary is client-rendered, so the
whole story is E2E by necessity — a Test Designer note, not an ambiguity.)

## Traceability

- Story: STORY-020
- Risks covered: RISK-001, RISK-002, RISK-003, RISK-004
