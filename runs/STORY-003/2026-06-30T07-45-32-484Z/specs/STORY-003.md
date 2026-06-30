# STORY-003 Cart Badge Decrement Regression

## Application Overview

SauceDemo (https://www.saucedemo.com) is a sample e-commerce application used for QA practice. After a refactor, the header cart badge showed a stale count after removing an item from the cart page — the count only corrected itself on the next page navigation or reload. STORY-003 covers the regression fix that makes the badge update immediately, in-place, without requiring any navigation. All three scenarios target the cart badge decrement behavior exclusively. Login is a precondition for all tests (username: standard_user, password: secret_sauce). Locators were verified live against the running app on 2026-06-30.

## Test Scenarios

### 1. Cart Badge Decrement Bug (STORY-003)

**Seed:** `tests/seed.spec.ts`

#### 1.1. TC-001 [P0 RISK-001] Remove item decrements badge in-place without reload or navigation

**File:** `tests/STORY-003/tc-001-badge-decrement-inplace.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce' using the fields [data-test='username'], [data-test='password'], and [data-test='login-button'].
   - expect: The app redirects to https://www.saucedemo.com/inventory.html
   - expect: The header cart badge element [data-test='shopping-cart-badge'] is absent — the DOM contains no badge span inside #shopping_cart_container

2. On the inventory page, click [data-test='add-to-cart-sauce-labs-backpack'] to add the Sauce Labs Backpack.
   - expect: The [data-test='add-to-cart-sauce-labs-backpack'] button is replaced by [data-test='remove-sauce-labs-backpack']
   - expect: The header badge [data-test='shopping-cart-badge'] appears in the DOM and shows the text '1'

3. Click [data-test='add-to-cart-sauce-labs-bike-light'] to add the Sauce Labs Bike Light.
   - expect: The [data-test='add-to-cart-sauce-labs-bike-light'] button is replaced by [data-test='remove-sauce-labs-bike-light']
   - expect: The header badge [data-test='shopping-cart-badge'] updates to show the text '2'

4. Click the cart link [data-test='shopping-cart-link'] to navigate to the cart page.
   - expect: The URL changes to https://www.saucedemo.com/cart.html
   - expect: The page heading reads 'Your Cart'
   - expect: Two cart items are visible: 'Sauce Labs Backpack' and 'Sauce Labs Bike Light'
   - expect: The header badge [data-test='shopping-cart-badge'] still shows '2'

5. On the cart page, click [data-test='remove-sauce-labs-backpack'] to remove the Sauce Labs Backpack.
   - expect: The Sauce Labs Backpack row is removed from the cart list
   - expect: Exactly one cart item remains: 'Sauce Labs Bike Light'

6. WITHOUT navigating or reloading — while still on https://www.saucedemo.com/cart.html — immediately read the text content of [data-test='shopping-cart-badge'].
   - expect: The badge element [data-test='shopping-cart-badge'] is still present in the DOM
   - expect: Its text content is exactly '1' (not '2' — which would be the stale/buggy value)
   - expect: The current URL is still https://www.saucedemo.com/cart.html (no navigation has occurred)

#### 1.2. TC-002 [P1 RISK-001] Empty cart hides the badge element entirely

**File:** `tests/STORY-003/tc-002-badge-absent-on-empty-cart.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce'.
   - expect: The app redirects to https://www.saucedemo.com/inventory.html
   - expect: The header cart badge [data-test='shopping-cart-badge'] is absent from the DOM

2. Click [data-test='add-to-cart-sauce-labs-backpack'] to add exactly one item to the cart.
   - expect: The header badge [data-test='shopping-cart-badge'] appears and shows the text '1'

3. Click the cart link [data-test='shopping-cart-link'] to open the cart page.
   - expect: The URL is https://www.saucedemo.com/cart.html
   - expect: Exactly one item is listed: 'Sauce Labs Backpack' with its Remove button [data-test='remove-sauce-labs-backpack']
   - expect: The header badge [data-test='shopping-cart-badge'] shows '1'

4. Click [data-test='remove-sauce-labs-backpack'] to remove the only item.
   - expect: The Sauce Labs Backpack row is removed from the cart list
   - expect: The cart list is now empty

5. WITHOUT navigating or reloading — while still on https://www.saucedemo.com/cart.html — query the DOM for [data-test='shopping-cart-badge'].
   - expect: The element [data-test='shopping-cart-badge'] is ABSENT from the DOM — document.querySelector('[data-test="shopping-cart-badge"]') returns null
   - expect: The badge does NOT display '0' or any other text — it is fully removed
   - expect: The #shopping_cart_container inner HTML contains only the bare anchor tag: <a class='shopping_cart_link' data-test='shopping-cart-link'></a> with no child span

#### 1.3. TC-003 [P2 RISK-001 RISK-002] Badge count is correct across subsequent navigation after in-place decrement

**File:** `tests/STORY-003/tc-003-badge-persists-across-navigation.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce'.
   - expect: The app redirects to https://www.saucedemo.com/inventory.html
   - expect: The header cart badge [data-test='shopping-cart-badge'] is absent from the DOM

2. Click [data-test='add-to-cart-sauce-labs-backpack'] to add the Sauce Labs Backpack, then click [data-test='add-to-cart-sauce-labs-bolt-t-shirt'] to add the Sauce Labs Bolt T-Shirt.
   - expect: After each addition the badge increments: first to '1', then to '2'
   - expect: Both items have their corresponding Remove buttons visible on the inventory page

3. Click [data-test='shopping-cart-link'] to navigate to the cart page.
   - expect: The URL is https://www.saucedemo.com/cart.html
   - expect: Both items appear: 'Sauce Labs Backpack' ([data-test='remove-sauce-labs-backpack']) and 'Sauce Labs Bolt T-Shirt' ([data-test='remove-sauce-labs-bolt-t-shirt'])
   - expect: The header badge [data-test='shopping-cart-badge'] shows '2'

4. Click [data-test='remove-sauce-labs-backpack'] to remove the Sauce Labs Backpack.
   - expect: The Sauce Labs Backpack row is removed
   - expect: Only 'Sauce Labs Bolt T-Shirt' remains in the cart

5. BEFORE any navigation — while still on https://www.saucedemo.com/cart.html — immediately assert the badge value. This step MUST precede all navigation steps below. Asserting after navigation alone would pass even on the buggy app because reloading self-corrects the stale count.
   - expect: The badge element [data-test='shopping-cart-badge'] is present in the DOM
   - expect: Its text content is exactly '1' — confirmed in-place without any navigation or reload

6. Click [data-test='continue-shopping'] to navigate to the inventory page.
   - expect: The URL changes to https://www.saucedemo.com/inventory.html
   - expect: The header badge [data-test='shopping-cart-badge'] shows '1'
   - expect: The 'Sauce Labs Backpack' shows an 'Add to cart' button (it was removed from the cart)
   - expect: The 'Sauce Labs Bolt T-Shirt' shows a 'Remove' button (it is still in the cart)

7. Click [data-test='shopping-cart-link'] to navigate back to the cart page.
   - expect: The URL is https://www.saucedemo.com/cart.html
   - expect: The header badge [data-test='shopping-cart-badge'] still shows '1'
   - expect: Only one cart item is listed: 'Sauce Labs Bolt T-Shirt'
   - expect: The Remove button [data-test='remove-sauce-labs-bolt-t-shirt'] is present
