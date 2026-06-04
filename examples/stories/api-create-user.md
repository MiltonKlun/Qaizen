# API — Create user and reject invalid registration (API-001)

> API-branch example story for Phase 1.5. Targets **reqres.in**
> (`https://reqres.in/api`), the demo API the project uses because
> Saucedemo has no real backend (see `docs/ambiguities.md` A3). The
> Analyst should treat this as `source: "manual"` with
> `story.id = "API-001"`. Every test case here is `automate_api` —
> there is no UI in scope.

## Goal

A client can create a user through the API and gets a well-formed
created-resource response; an attempt to register without the required
password is rejected with a clear client error. These are server-side
contract checks, not UI flows.

## Acceptance criteria

1. Given a valid JSON body with a name and a job, when the client POSTs
   to `/users`, then the API responds `201 Created` with a body
   containing a non-empty `id` and a `createdAt` timestamp.
2. Given a registration body that has an email but no password, when
   the client POSTs to `/register`, then the API responds `400 Bad
Request` with a body containing an `error` field describing the
   missing password. No account is created.

## Out of scope

- Any UI. This story is API-only; there is no screen to exercise.
- Authentication / authorization flows (reqres.in's endpoints used here
  are unauthenticated).
- Pagination, listing, update, and delete endpoints — separate stories.
- Rate limiting and performance.

## Notes for the QA pipeline

- Both ACs are server-side contracts: a status code plus a response
  shape. The Test Designer is expected to mark both `automate_api`
  (per `docs/automation-decision-model.md`, status-code and
  data-shape checks belong at the API level).
- AC #2 is reqres.in's documented missing-field failure mode — a
  reliable negative case for exercising the API branch end-to-end.
- The base URL belongs in the Postman environment as `{{base_url}}`,
  never hardcoded in the collection.
