# Login — Successful sign-in (STORY-001)

> Manual-mode example story for Phase 1. Targets a generic
> username/password demo app (e.g. https://www.saucedemo.com or any
> equivalent). The Analyst should treat this as `source: "manual"`
> and produce `context.json` with `story.id = "STORY-001"`.

## Goal

A registered, non-locked user can sign in with valid credentials and
land on the home page that lists their available inventory.

## Acceptance criteria

1. Given a registered, non-locked user with valid credentials, when
   they submit the login form, then they are taken to the home page
   and see the inventory list.
2. Given an invalid password, when the user submits the form, then
   they remain on the login page and an error message explains the
   credentials were not accepted. No partial session is created.
3. Given a locked user, when they submit valid credentials, then
   they remain on the login page and an error message explains the
   account is locked. No session is created.

## Out of scope

- Password reset, account creation, social login, MFA.
- Persistent "remember me" across sessions.
- Performance: login latency is not under test here.
- Visual styling.

## Notes for the QA pipeline

- This story is intentionally small so the vertical slice can
  exercise the full chain (Analyst → Gates 1–4 → execution → bug
  drafts → report) without getting lost in scope.
- The locked-user case is a permission/role check. The Test Designer
  is expected to mark it `automate_api` rather than `automate_e2e`
  unless the UI signal is the AC (it is not — the AC is about
  session creation, which is a server-side guarantee).
