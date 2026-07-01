# STORY-020 Checkout Order Summary

## Application Overview

SauceDemo (https://www.saucedemo.com) checkout flow for STORY-020. The plan covers the Checkout: Overview step and the surrounding steps needed to reach it: adding two specific items (Sauce Labs Backpack at $29.99 and Sauce Labs Bike Light at $9.99) to the cart, proceeding through the Information step, and verifying the order summary, pricing math, validation behaviour, and post-order state. All locators, element texts, and price values are drawn from direct observation of the running app on 2026-06-30.

## Test Scenarios

### 1. STORY-020 — Checkout Order Summary

**Seed:** ``

#### 1.1. TC-001 (P0 · RISK-004): Two-item checkout reaches the Overview step

**File:** `tests/STORY-020/TC-001-checkout-overview.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce' using [data-test='username'], [data-test='password'], and [data-test='login-button'].
   - expect: The browser navigates to /inventory.html and the Products page heading is visible.

2. Click the 'Add to cart' button for the Sauce Labs Backpack ([data-test='add-to-cart-sauce-labs-backpack']).
   - expect: The button label changes to 'Remove'. The cart badge ([data-test='shopping-cart-badge']) shows '1'.

3. Click the 'Add to cart' button for the Sauce Labs Bike Light ([data-test='add-to-cart-sauce-labs-bike-light']).
   - expect: The button label changes to 'Remove'. The cart badge shows '2'.

4. Click the cart icon/link ([data-test='shopping-cart-link']) to open the cart.
   - expect: The browser navigates to /cart.html. The page heading reads 'Your Cart'. Both items — 'Sauce Labs Backpack' and 'Sauce Labs Bike Light' — are listed.

5. Click the 'Checkout' button ([data-test='checkout']).
   - expect: The browser navigates to /checkout-step-one.html. The page heading reads 'Checkout: Your Information'. Three input fields are visible: First Name ([data-test='firstName']), Last Name ([data-test='lastName']), and Zip/Postal Code ([data-test='postalCode']).

6. Fill in First Name with 'Jane', Last Name with 'Tester', and Zip/Postal Code with '90210' using the respective [data-test] inputs. Click the 'Continue' button ([data-test='continue']).
   - expect: The browser navigates to /checkout-step-two.html. The page title element ([data-test='title']) contains the text 'Checkout: Overview'.

7. Inspect the item list on the Overview page.
   - expect: Exactly two items are displayed under the QTY / Description columns.
   - expect: An element with [data-test='inventory-item-name'] reads 'Sauce Labs Backpack'.
   - expect: An element with [data-test='inventory-item-name'] reads 'Sauce Labs Bike Light'.
   - expect: Each item shows a price element with [data-test='inventory-item-price']: $29.99 for the Backpack and $9.99 for the Bike Light.

#### 1.2. TC-002 (P0 · RISK-001): Item total equals sum of individual unit prices

**File:** `tests/STORY-020/TC-002-item-total-math.spec.ts`

**Steps:**

1. Set up state: log in, add Sauce Labs Backpack and Sauce Labs Bike Light to the cart, open the cart, click Checkout, fill the Information step with valid values (e.g. First Name='Jane', Last Name='Tester', Zip='90210'), and click Continue to reach /checkout-step-two.html.
   - expect: The page title ([data-test='title']) reads 'Checkout: Overview'.

2. Read the text content of all [data-test='inventory-item-price'] elements on the page. Strip the leading '$' and parse each as a floating-point number. Sum them.
   - expect: Two price elements are found: $29.99 (Sauce Labs Backpack) and $9.99 (Sauce Labs Bike Light). Their parsed numeric sum is 39.98.

3. Read the text content of [data-test='subtotal-label']. Strip the 'Item total: $' prefix and parse the remainder as a floating-point number.
   - expect: The rendered text is 'Item total: $39.98'. The parsed value is 39.98.

4. Assert that the parsed 'Item total' value equals the computed sum of unit prices (both rounded to two decimal places).
   - expect: 39.98 === 29.99 + 9.99 is true. The assertion passes. If the values differ even by one cent the test must fail.

#### 1.3. TC-003 (P0 · RISK-002): Total equals Item total plus Tax

**File:** `tests/STORY-020/TC-003-total-tax-math.spec.ts`

**Steps:**

1. Set up state: log in, add Sauce Labs Backpack and Sauce Labs Bike Light to the cart, open the cart, click Checkout, fill the Information step with valid values (e.g. First Name='Jane', Last Name='Tester', Zip='90210'), and click Continue to reach /checkout-step-two.html.
   - expect: The page title ([data-test='title']) reads 'Checkout: Overview'.

2. Read [data-test='subtotal-label'] text and parse the dollar amount after 'Item total: $' as a float.
   - expect: The rendered text is 'Item total: $39.98'. Parsed value: 39.98.

3. Read [data-test='tax-label'] text and parse the dollar amount after 'Tax: $' as a float.
   - expect: The rendered text is 'Tax: $3.20'. Parsed value: 3.20.

4. Read [data-test='total-label'] text and parse the dollar amount after 'Total: $' as a float.
   - expect: The rendered text is 'Total: $43.18'. Parsed value: 43.18.

5. Assert that the parsed Total equals the parsed Item total plus the parsed Tax, to the cent. Use integer cent arithmetic (multiply each value by 100 and round) to avoid floating-point rounding errors.
   - expect: Math.round(39.98 _ 100) + Math.round(3.20 _ 100) === Math.round(43.18 \* 100) is true (3998 + 320 === 4318). The assertion passes. Any discrepancy, even one cent, must cause the test to fail.

#### 1.4. TC-004 (P1 · RISK-003): Missing Zip/Postal Code blocks checkout and shows error

**File:** `tests/STORY-020/TC-004-missing-zip-error.spec.ts`

**Steps:**

1. Set up state: log in, add Sauce Labs Backpack and Sauce Labs Bike Light to the cart, open the cart, and click the Checkout button ([data-test='checkout']).
   - expect: The browser is on /checkout-step-one.html with the heading 'Checkout: Your Information'.

2. Fill in the First Name field ([data-test='firstName']) with 'Jane' and the Last Name field ([data-test='lastName']) with 'Tester'. Leave the Zip/Postal Code field ([data-test='postalCode']) completely empty.
   - expect: First Name contains 'Jane'. Last Name contains 'Tester'. Zip/Postal Code is empty.

3. Click the Continue button ([data-test='continue']).
   - expect: The page URL remains /checkout-step-one.html — the browser has NOT navigated to /checkout-step-two.html.
   - expect: An error heading element ([data-test='error']) is visible on the page.
   - expect: The text of [data-test='error'] reads 'Error: Postal Code is required'.

#### 1.5. TC-005 (P1 · RISK-004): Clicking Finish completes the order and clears the cart

**File:** `tests/STORY-020/TC-005-finish-clears-cart.spec.ts`

**Steps:**

1. Set up state: log in, add Sauce Labs Backpack and Sauce Labs Bike Light to the cart, open the cart, click Checkout, fill the Information step with valid values (e.g. First Name='Jane', Last Name='Tester', Zip='90210'), click Continue, and confirm the page title ([data-test='title']) reads 'Checkout: Overview'.
   - expect: The browser is on /checkout-step-two.html. The cart badge ([data-test='shopping-cart-badge']) shows '2'.

2. Click the Finish button ([data-test='finish']).
   - expect: The browser navigates to /checkout-complete.html.

3. Assert the page title element ([data-test='title']) contains 'Checkout: Complete!'.
   - expect: The text 'Checkout: Complete!' is present on the page.

4. Assert the confirmation heading element ([data-test='complete-header']) is visible.
   - expect: The element [data-test='complete-header'] is visible and its text reads 'Thank you for your order!'.

5. Assert that the cart badge element ([data-test='shopping-cart-badge']) is NOT present in the DOM.
   - expect: document.querySelector('[data-test="shopping-cart-badge"]') returns null. The cart is empty and no badge is rendered — confirming the cart was cleared upon order completion.
