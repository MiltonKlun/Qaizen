# The order review shows the right items figure, sales tax and order total (BENCH-2)

> Manual-mode story for the local Bench Shop (`examples/benchmark-app/`;
> `--bug wrong-item-total` and `--bug inconsistent-total` break it). The
> Analyst should treat it as `source: "manual"` and produce `context.json`
> with `story.id = "BENCH-2"`.

## Goal

A shopper with products in the basket can check out: enter delivery details,
review the order, and place it. The review must show the right **Items**
figure (the sum of the basket's prices), the **Sales tax**, and the **Order
total** (Items plus Sales tax), so the shopper sees the true amount before
placing the order.

## Acceptance criteria

1. Given a shopper with two products in the basket, when they go to checkout
   and submit a given name, a family name and a postcode, then they reach the
   "Review your order" screen listing both products.
2. Given the order review, when the summary is shown, then the "Items" figure
   equals the exact sum of the prices of the products in the basket.
3. Given the order review, when the summary is shown, then the "Order total"
   equals the shown "Items" figure plus the shown "Sales tax".
4. Given the delivery details screen, when the shopper submits it with a
   required field empty (for example no postcode), then they stay on that
   screen and a message says what is missing; they do not reach the review.
5. Given the order review, when the shopper places the order, then they reach
   the "Order placed" confirmation and the basket count is cleared.

## Out of scope

- Changing the basket during checkout (its contents are set up before).
- Payment (Bench Shop takes none).
- Order history.
- How the checkout screens look.
- Where the cancel and back buttons lead.

## Notes for the QA pipeline

- AC 1, AC 4 and AC 5 are journey assertions → `automate_e2e`.
- AC 2 and AC 3 are the money guarantees and the regression-critical cases.
  They are visible only on the rendered review (Bench Shop has no API), so
  they are `automate_e2e` too. The tests must read the prices and figures the
  screen shows and compute the expected values from them, never copy a number
  from this story; the story gives none on purpose.
- The sign-in screen shows the demo account. Every hook, price and figure
  is on the running app: read them from it.
