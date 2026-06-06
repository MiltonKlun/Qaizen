# STORY-001 Login Slice — Playwright Test Plan

## Application Overview

Playwright test plan for the Saucedemo login slice (STORY-001). Covers two automated E2E scenarios approved by the Test Designer: TC-001 (happy-path login) and TC-002 (invalid-password rejection). TC-003 (locked-account API boundary) is out of scope for this planner — it is handled by the Phase 1.5 API Agent. TC-004 (visual styling review) is a manual test; it is not scripted here. The application under test is https://www.saucedemo.com/. All locators were observed by driving the live application via the playwright-test MCP on 2026-05-31; no locators were invented from text. Exploration stopped at the inventory landing page in strict compliance with the out-of-scope boundary in planner-input/STORY-001.planner-brief.md.

## Test Scenarios

### 1. STORY-001 Login

**Seed:** `tests/seed.spec.ts`

#### 1.1. SPEC-001: Happy-path login — TC-001 (Linked TC: TC-001, Linked RISK: RISK-001)

**File:** `tests/STORY-001.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com/ (BASE_URL). The page title is 'Swag Labs'. Confirm the login form is visible: a textbox labelled 'Username', a textbox labelled 'Password', and a button labelled 'Login' are all present in the accessibility tree.
   - expect: Page URL is https://www.saucedemo.com/
   - expect: A textbox with accessible name 'Username' is visible — use getByRole('textbox', { name: 'Username' }) or the data-test attribute [data-test='username']
   - expect: A textbox with accessible name 'Password' is visible — use getByRole('textbox', { name: 'Password' }) or [data-test='password']
   - expect: A button with accessible name 'Login' is visible — use getByRole('button', { name: 'Login' }) or [data-test='login-button']

2. Fill the Username textbox (getByRole('textbox', { name: 'Username' }) / [data-test='username']) with the value 'standard_user'.
   - expect: The textbox value is 'standard_user'

3. Fill the Password textbox (getByRole('textbox', { name: 'Password' }) / [data-test='password']) with the value 'secret_sauce'.
   - expect: The textbox value is 'secret_sauce'

4. Click the Login button (getByRole('button', { name: 'Login' }) / [data-test='login-button']).
   - expect: The page navigates away from the login page
   - expect: Page URL changes to https://www.saucedemo.com/inventory.html (path ends in /inventory.html)
   - expect: No error banner or error heading is present in the DOM
   - expect: The inventory grid is visible: at least one product link is present — confirmed by observing links such as 'Sauce Labs Backpack', 'Sauce Labs Bike Light', etc. Use expect(page.getByRole('link', { name: 'Sauce Labs Backpack' })).toBeVisible() or assert that the inventory list container holds at least one item. The MCP-observed selector for items is .inventory_item (six items rendered on first load).
   - expect: The page heading or title area contains 'Products'

#### 1.2. SPEC-002: Invalid-password rejection — TC-002 (Linked TC: TC-002, Linked RISK: RISK-001)

**File:** `tests/STORY-001.spec.ts`

**Steps:**

1. Navigate to https://www.saucedemo.com/ (BASE_URL). Confirm the login form is visible (same precondition as SPEC-001 — fresh page, no prior session).
   - expect: Page URL is https://www.saucedemo.com/
   - expect: Username textbox, Password textbox, and Login button are all visible
   - expect: No error banner is present at this point

2. Fill the Username textbox ([data-test='username'] / getByRole('textbox', { name: 'Username' })) with the value 'standard_user'.
   - expect: The textbox value is 'standard_user'

3. Fill the Password textbox ([data-test='password'] / getByRole('textbox', { name: 'Password' })) with a deliberately wrong value: 'wrong-password'.
   - expect: The textbox value is 'wrong-password'

4. Click the Login button ([data-test='login-button'] / getByRole('button', { name: 'Login' })).
   - expect: The page does NOT navigate away from the login page — URL remains https://www.saucedemo.com/ (path is '/')
   - expect: An error banner is now visible in the DOM. It is rendered as an h3 heading element. The exact verbatim text observed on 2026-05-31 is: 'Epic sadface: Username and password do not match any user in this service'. Assert with: expect(page.getByRole('heading', { name: /Epic sadface: Username and password do not match any user in this service/ })).toBeVisible()
   - expect: The error banner contains the dismiss button (an img/button child of the h3) — its presence confirms the error component rendered fully
   - expect: The Username textbox still shows 'standard_user' and the Password textbox still shows the entered value — the form was not cleared by the rejection
   - expect: No session cookie or auth token is set (the URL did not change to /inventory.html, confirming no partial session was created — this is the RISK-001 assertion)
