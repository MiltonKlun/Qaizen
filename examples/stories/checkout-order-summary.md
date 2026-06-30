# Checkout order summary shows the correct item total, tax, and total (STORY-020)

> Manual-mode story. Targets the SauceDemo shopping demo app
> (https://www.saucedemo.com). The Analyst should treat this as
> `source: "manual"` and produce `context.json` with
> `story.id = "STORY-020"`. New territory for the evaluation dataset:
> the multi-step checkout journey and its money math (not previously
> covered by the login / cart-badge / sort stories).

## Goal

A shopper who has items in their cart can complete the two-step checkout
(enter their information, review the order summary, and finish the
purchase). The order-summary step must show the correct **item total**
(sum of the cart item prices), the **tax**, and the **total**
(item total + tax) — so the shopper sees an accurate amount before they
commit to the order.

## Acceptance criteria

1. Given a shopper with two known items in the cart, when they proceed
   to checkout and submit valid first name, last name, and postal code,
   then they reach the "Checkout: Overview" step showing both items.
2. Given the checkout overview step, when the order summary is displayed,
   then the "Item total" equals the exact sum of the unit prices of the
   items in the cart.
3. Given the checkout overview step, when the order summary is displayed,
   then the "Total" equals the displayed "Item total" plus the displayed
   "Tax" (the arithmetic on screen is internally consistent).
4. Given the checkout information step, when the shopper submits the form
   with a missing required field (e.g. no postal code), then they remain
   on the information step and an error message is shown — they do not
   advance to the overview.
5. Given the checkout overview step, when the shopper clicks "Finish",
   then they reach the "Checkout: Complete!" confirmation and the cart
   badge is cleared (the order has been placed).

## Out of scope

- Adding/removing items inside the checkout flow (cart contents are a
  precondition, set up before checkout begins).
- Real payment processing (SauceDemo has no real payment backend).
- Persisting an order history across sessions.
- Visual styling of the checkout pages.
- The "Cancel" buttons' navigation targets (separate concern).

## Notes for the QA pipeline

- AC 1, AC 4, AC 5 are UI-journey assertions (multi-step form, error
  state, confirmation) → `automate_e2e`.
- AC 2 and AC 3 are the money-math guarantees — the highest-value cases.
  They are observable only on the rendered overview page (SauceDemo has
  no order-summary API), so they are `automate_e2e` too, but they are
  the regression-critical ones: a wrong item total or an inconsistent
  total is a money bug. The Planner/Generator must read the actual
  rendered prices and compute the expected sum, NOT hard-code a magic
  number from the story text.
- Standard SauceDemo user `standard_user` / `secret_sauce`, base URL
  https://www.saucedemo.com. Known item prices to use: Sauce Labs
  Backpack ($29.99) and Sauce Labs Bike Light ($9.99), but the tests
  should read the prices live rather than assume them.
