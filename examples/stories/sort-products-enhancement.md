# Add "sort products by price" to the inventory page (STORY-004)

> Manual-mode **enhancement** example story. Targets a generic
> shopping demo app (e.g. https://www.saucedemo.com). The Analyst
> should treat this as `source: "manual"` and produce `context.json`
> with `story.id = "STORY-004"`. Enhancement variety for the
> evaluation dataset (mixed E2E + API).

## Goal

Add a sort control to the inventory page so a shopper can order
products by price, low-to-high and high-to-low. This is net-new
functionality, not a fix — the inventory list currently has no sort
affordance.

## Acceptance criteria

1. Given the inventory page, when the user selects "Price (low to
   high)", then the products are reordered so each product's price is
   greater than or equal to the one before it.
2. Given the inventory page, when the user selects "Price (high to
   low)", then the products are reordered so each product's price is
   less than or equal to the one before it.
3. Given a sort has been applied, when the inventory data is requested
   from the products endpoint with the corresponding `sort` parameter,
   then the endpoint returns the items already ordered (the sort is
   enforced server-side, not only re-ordered in the browser).
4. Given an invalid `sort` parameter value, when the products endpoint
   is called, then it responds 400 with an error and does not fall
   back to an arbitrary order.

## Out of scope

- Sorting by name or by rating (only price for this story).
- Persisting the chosen sort across sessions.
- Pagination interaction with sort.
- Visual styling of the sort dropdown.

## Notes for the QA pipeline

- AC 1 and AC 2 are UI-journey assertions (the visible order changes
  after selecting an option) → `automate_e2e`.
- AC 3 and AC 4 are contract assertions on the products endpoint
  (server-side ordering, 400 on a bad parameter) → `automate_api`.
  This makes the story a good mixed-branch evaluation case, and it
  should NOT be E2E-heavy: the server-side guarantees belong at the
  API layer per docs/automation-decision-model.md.
