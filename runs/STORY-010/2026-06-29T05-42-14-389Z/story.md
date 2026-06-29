# Cart badge reflects item count on the inventory page (STORY-010)

> Manual-mode story for a system-test run of the Qaizen pipeline.
> Targets the SauceDemo shopping demo app (https://www.saucedemo.com).
> The Analyst should treat this as `source: "manual"` and produce
> `context.json` with `story.id = "STORY-010"`.

## Goal

A shopper on the inventory page can add and remove products, and the
cart badge on the top navigation always shows the current number of
distinct items in the cart. The badge is the shopper's at-a-glance
confirmation that an add/remove action took effect.

## Acceptance criteria

1. Given a signed-in shopper on the inventory page with an empty cart,
   when they add a product to the cart, then the cart badge appears and
   shows the count "1".
2. Given a shopper who has added two distinct products, when the
   inventory page shows the cart badge, then the badge shows the count
   "2".
3. Given a shopper with one or more products in the cart, when they
   remove a product from the inventory page, then the cart badge
   decrements to reflect the new count, and the badge disappears
   entirely when the cart returns to empty.
4. Given a shopper with items in the cart, when they navigate away to
   the cart page and back to the inventory page, then the cart badge
   still shows the correct count (the count is not lost on navigation).

## Out of scope

- Checkout, payment, and the order-confirmation flow.
- Quantity-per-line-item (SauceDemo carts hold one of each product;
  the badge counts distinct items, not quantities).
- Cart persistence across full logout/login sessions.
- Visual styling of the badge.

## Notes for the QA pipeline

- All four ACs are observable UI-journey assertions on saucedemo.com
  (the visible badge count changes after an action) → expected to be
  `automate_e2e`. There is no separate documented backend API for
  SauceDemo's cart, so this story is intentionally E2E-only — a good
  contrast to the mixed-branch sort story.
- The standard SauceDemo user `standard_user` / `secret_sauce` and the
  base URL https://www.saucedemo.com are the test fixtures.
