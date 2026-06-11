# DEMO-1 — User can log in and see the product inventory

> **Demo fixture** (`examples/demo-run/`, IMPROVEMENT-PLAN Phase 3). This is
> the story the 10-minute demo replays. It is intentionally small, and the
> demo app contains ONE planted bug against AC-2 so the full
> FAIL → classify → BUG-draft → release-report chain can be experienced.

## Story

As a returning customer, I want to log in with my credentials so that I can
see the product inventory and start shopping.

## Acceptance criteria

1. Given valid credentials (`demo` / `demo123`), when the user submits the
   login form, then they see the inventory page with the heading
   **"Products"** and at least one product listed.
2. Given an invalid password, when the user submits the login form, then they
   remain on the login form and see the error message exactly
   **"Invalid credentials"**, and no session is created.
3. Given a logged-in user, when they press **Logout**, then they return to
   the login form and the session is cleared.

## Notes

- The demo application is a single static page (`app/index.html`) served
  locally — no network, no backend, fully deterministic.
- Planted bug: on an invalid password the app shows **"Wrong password!"**
  instead of the agreed copy "Invalid credentials" (violates AC-2).
