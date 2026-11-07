# Cart badge shows stale item count after removing an item (STORY-003)

> Manual-mode **bug-fix** example story. Targets a generic shopping
> demo app (e.g. https://www.saucedemo.com). The Analyst should treat
> this as `source: "manual"` and produce `context.json` with
> `story.id = "STORY-003"`. Bug-fix variety for the evaluation dataset.

## Goal

The cart badge in the header must always reflect the true number of
items in the cart. After a user removes an item, the badge must
decrement immediately — it currently shows the pre-removal count until
a full page reload.

## Background (the bug)

A recent refactor moved the badge's count from a derived value to a
cached one that is only recomputed on navigation. Removing an item
updates the cart store but not the cached badge, so the header lies
until the next page load. No data is lost — the cart contents are
correct — but the visible count is wrong, which erodes trust at the
exact moment a user is deciding whether to check out.

## Acceptance criteria

1. Given a cart with N items, when the user removes one item from the
   cart page, then the header badge updates to N-1 without a page
   reload.
2. Given the user removes the last remaining item, when the cart
   becomes empty, then the header badge is hidden entirely (not shown
   as "0").
3. Given the user removes an item, when they navigate to another page
   and back, then the badge still shows the correct count (the fix
   must not depend on a reload to "correct itself").

## Out of scope

- Adding items to the cart (the increment path already works).
- Cart total price recomputation (separate concern, separate story).
- Persisting the cart across sessions.
- Visual styling of the badge.

## Notes for the QA pipeline

- This is a regression fix, so the highest-value cases are the ones
  that would have caught the regression: the immediate-decrement
  assertion (AC 1) and the empty-cart hide (AC 2).
- AC 1 and AC 3 are UI-journey assertions (badge state across
  interactions) → likely `automate_e2e`. There is no server-side
  contract here; the badge is a client-rendered value, so an API test
  would not exercise the bug.
