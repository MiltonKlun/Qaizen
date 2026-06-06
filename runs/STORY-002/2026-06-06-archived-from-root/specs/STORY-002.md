# STORY-002 E2E Login Spec

## Application Overview

Playwright E2E spec for STORY-002 (Account access and provisioning — UI portion only). Covers the two approved E2E test cases: TC-001 happy-path login and TC-002 invalid-password rejection. Scope is strictly limited to the Saucedemo login page and the inventory landing page. API branch (TC-003, TC-004 against reqres.in), cart, checkout, sort, product detail, and all other features are out of scope for this spec. Traceability: STORY-002 → RISK-001 → TC-001/TC-002 → SPEC-001/SPEC-002 → tests/STORY-002.spec.ts. Application under test: https://www.saucedemo.com/.

## Test Scenarios

### 1. Saucedemo Login — STORY-002 E2E

**Seed:** `tests/seed.spec.ts`

#### 1.1. SPEC-001 — Happy-path login redirects to inventory (Linked TC: TC-001, Linked RISK: RISK-001)

**File:** `tests/STORY-002.spec.ts`

**Steps:**

1. Navigate to BASE_URL (https://www.saucedemo.com/).
   - expect: The login page is displayed with the title 'Swag Labs'.
   - expect: The URL is https://www.saucedemo.com/.

2. Fill the Username field using the locator [data-test='username'] (primary, most robust — stable data-test hook present on the element; runner-up: getByRole('textbox', { name: 'Username' })) with the value 'standard_user'.
   - expect: The Username field contains the text 'standard_user'.

3. Fill the Password field using the locator [data-test='password'] (primary; runner-up: getByRole('textbox', { name: 'Password' })) with the value 'secret_sauce'.
   - expect: The Password field is filled.

4. Click the Login button using the locator [data-test='login-button'] (primary; runner-up: getByRole('button', { name: 'Login' })).
   - expect: The page navigates away from the login page.
   - expect: The URL changes to https://www.saucedemo.com/inventory.html (exact post-login URL observed from the live app).
   - expect: The URL path ends in /inventory.html.
   - expect: At least one element with [data-test='inventory-item'] is visible on the page, confirming the inventory list has rendered.

#### 1.2. SPEC-002 — Invalid password is rejected and no session is created (Linked TC: TC-002, Linked RISK: RISK-001)

**File:** `tests/STORY-002.spec.ts`

**Steps:**

1. Navigate to BASE_URL (https://www.saucedemo.com/). This step starts from a clean browser context with no pre-existing session cookies.
   - expect: The login page is displayed.
   - expect: The URL is https://www.saucedemo.com/.

2. Fill the Username field using [data-test='username'] with the value 'standard_user'.
   - expect: The Username field contains 'standard_user'.

3. Fill the Password field using [data-test='password'] with the value 'wrong-password' (an intentionally incorrect password).
   - expect: The Password field is filled with the wrong value.

4. Click the Login button using [data-test='login-button'].
   - expect: The URL does NOT change — it remains https://www.saucedemo.com/ (the login page, path '/'), confirming no redirect occurred.
   - expect: The error banner heading [data-test='error'] (an H3 element) is visible and contains the exact text: 'Epic sadface: Username and password do not match any user in this service' (verbatim from live app snapshot).
   - expect: No session-username cookie is set in the browser context. The Generator MUST implement this assertion by reading document.cookie or using the Playwright context.cookies() API and asserting that no cookie named 'session-username' is present. This is the RISK-001 no-session signal: Saucedemo sets a session-username cookie only after a successful login, so its absence after a failed login is the authoritative proof that no session was created.
   - expect: The inventory page ([data-test='inventory-container']) is NOT visible — the user is still on the login page.
