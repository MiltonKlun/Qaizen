# Spec — STORY-010: Cart badge reflects item count on the inventory page

> Authored by the Playwright Planner after exploring the **running** SauceDemo
> app (https://www.saucedemo.com) via Playwright MCP — not from story text alone
> (CLAUDE.md §3.8). Observed during exploration: login as standard_user lands on
> /inventory.html with NO cart badge; clicking "Add to cart" on the Backpack
> made a badge appear showing "1". Locators below are the stable `data-test`
> attributes the app actually exposes (confirmed live).

**Story:** STORY-010 · **Risks covered:** RISK-001, RISK-002, RISK-003
**App under test:** https://www.saucedemo.com · **User:** standard_user / secret_sauce

## Shared preconditions (all scenarios)

1. Navigate to https://www.saucedemo.com.
2. Sign in: fill `[data-test="username"]` = standard_user, `[data-test="password"]` = secret_sauce, click `[data-test="login-button"]`.
3. Assert the URL is `…/inventory.html`.
4. Assert no cart badge is present: `[data-test="shopping-cart-badge"]` is hidden / not attached.

Observed locators (live):
- Add buttons: `[data-test="add-to-cart-sauce-labs-backpack"]`, `[data-test="add-to-cart-sauce-labs-bike-light"]`.
- Remove buttons (after adding): `[data-test="remove-sauce-labs-backpack"]`, `[data-test="remove-sauce-labs-bike-light"]`.
- Cart badge (count): `[data-test="shopping-cart-badge"]` — renders the count text; absent when cart is empty.
- Cart link: `[data-test="shopping-cart-link"]`.
- Continue shopping (cart page): `[data-test="continue-shopping"]`.

---

## Scenario 1 — Badge appears showing "1" after adding one product (TC-001, RISK-001) @smoke

**Steps**
1. From the inventory page (empty cart), click `[data-test="add-to-cart-sauce-labs-backpack"]`.

**Expected**
- `[data-test="shopping-cart-badge"]` becomes visible.
- Its text equals `"1"`.

## Scenario 2 — Badge shows "2" after adding two distinct products (TC-002, RISK-001) @regression

**Steps**
1. Click `[data-test="add-to-cart-sauce-labs-backpack"]`.
2. Click `[data-test="add-to-cart-sauce-labs-bike-light"]`.

**Expected**
- `[data-test="shopping-cart-badge"]` text equals `"2"`.

## Scenario 3 — Remove decrements; badge disappears at empty (TC-003, RISK-002) @smoke

**Steps**
1. Add Backpack and Bike Light (badge shows "2").
2. Click `[data-test="remove-sauce-labs-backpack"]`.
3. Assert badge text equals `"1"`.
4. Click `[data-test="remove-sauce-labs-bike-light"]`.

**Expected**
- After step 2, badge text equals `"1"`.
- After step 4, `[data-test="shopping-cart-badge"]` is no longer visible (cart empty) — assert hidden/not attached, NOT a count of "0".

## Scenario 4 — Count survives navigation to cart and back (TC-004, RISK-003) @regression

**Steps**
1. Add Backpack and Bike Light (badge shows "2").
2. Click `[data-test="shopping-cart-link"]` to open the cart page.
3. Click `[data-test="continue-shopping"]` to return to the inventory page.

**Expected**
- On the inventory page, `[data-test="shopping-cart-badge"]` text still equals `"2"`.

---

## Out of scope (from the planner brief — not explored, not specced)

Checkout/payment, quantity-per-line, cross-session persistence, badge styling,
and the login flow beyond the precondition sign-in.
