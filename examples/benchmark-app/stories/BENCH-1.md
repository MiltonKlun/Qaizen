# Basket count stays behind after taking an item out (BENCH-1)

> Manual-mode **bug-fix** story for the local Bench Shop
> (`examples/benchmark-app/`, `--bug stale-badge` reproduces it). The Analyst
> should treat it as `source: "manual"` and produce `context.json` with
> `story.id = "BENCH-1"`.

## Goal

The basket count in the header must always show how many products are in the
basket. After a shopper takes a product out, the count must go down at once;
today it keeps the old number until the shopper moves to another screen.

## Background (the bug)

The count was moved from a value worked out from the basket to a cached one
that is only refreshed when the screen changes. Taking a product out updates
the basket but not the cached count, so the header is wrong until the next
screen. The basket itself is right; the number shown is not, at the moment a
shopper decides whether to check out.

## Acceptance criteria

1. Given a basket with N products, when the shopper takes one out on the
   basket screen, then the header basket count shows N-1 without changing
   screen.
2. Given the shopper takes out the last product, when the basket becomes
   empty, then the header basket count is hidden (not shown as "0").
3. Given the shopper has taken a product out, when they go to another screen
   and back, then the basket count still shows the right number.

## Out of scope

- Adding products to the basket (that path works).
- The money shown on the order review (a separate story, BENCH-2).
- Keeping the basket across sessions.
- How the count looks.

## Notes for the QA pipeline

- This is a regression fix: the cases that matter most are the ones that
  would have caught it, the immediate count after a take-out (AC 1) and the
  hidden count for an empty basket (AC 2).
- The count is rendered in the browser and has no API, so these are
  `automate_e2e`.
- The sign-in screen shows the demo account. Every hook, price and figure
  is on the running app: read them from it.
