# Account access and provisioning (STORY-002)

> Composite Phase 1.5 demo story. It deliberately spans two demo
> targets so the dual E2E/API pipeline can be exercised in one run:
>
> - The **UI / access** part runs against **Saucedemo**
>   (`https://www.saucedemo.com/`) — the E2E branch.
> - The **API / provisioning** part runs against **reqres.in**
>   (`https://reqres.in/api`) — the API branch.
>
> In a real project these would be one application with one backend.
> Here they are two demo services standing in for "the UI" and "the
> API" so the pipeline's dual flow can be validated. See
> `docs/ambiguities.md` A3 for why the API target is reqres.in.
>
> Manual mode: `story.id = "STORY-002"`, `source: "manual"`.

## Goal

A registered user can sign in through the web UI, and the system can
provision new user accounts through the API while rejecting malformed
provisioning requests. The story covers both the user-facing sign-in
and the server-side account-creation contract.

## Acceptance criteria

1. (UI) Given a registered, non-locked user with valid credentials,
   when they submit the login form, then they are taken to the home
   page and see the inventory list.
2. (UI) Given an invalid password, when the user submits the form,
   then they remain on the login page and an error message explains
   the credentials were not accepted. No session is created.
3. (API) Given a valid JSON body with a name and a job, when a client
   POSTs to `/users`, then the API responds `201 Created` with a body
   containing a non-empty `id` and a `createdAt` timestamp.
4. (API) Given a registration body that has an email but no password,
   when a client POSTs to `/register`, then the API responds `400 Bad
Request` with a body containing an `error` field describing the
   missing password. No account is created.

## Out of scope

- Password reset, account creation via UI, social login, MFA,
  "remember me".
- API authentication / authorization (the reqres.in endpoints used
  here are unauthenticated).
- Listing, updating, or deleting users via API — separate stories.
- Cart, checkout, and any Saucedemo flow past the inventory landing.
- Performance, rate limiting, and visual styling.

## Notes for the QA pipeline

- ACs 1–2 are user-journey + UI-feedback checks → `automate_e2e`
  against Saucedemo.
- ACs 3–4 are server-side contract checks (status code + response
  shape) → `automate_api` against reqres.in, per
  `docs/automation-decision-model.md`.
- AC #4 is reqres.in's documented missing-field failure mode — a
  reliable negative case.
- The API base URL belongs in the Postman environment as
  `{{base_url}}`, never hardcoded.
