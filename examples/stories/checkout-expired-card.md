# Checkout — Reject expired credit card (QA-1042)

> Jira-mode example story for Phase 1. Treat this file as the local
> copy the Analyst writes after fetching the issue via
> `mcp-atlassian:jira_get_issue`. The Analyst should set
> `story.id = "QA-1042"`, `story.source = "jira"`,
> `story.jira_issue_key = "QA-1042"`, and `story.path = "story.md"`
> (this file becomes `story.md` at the project root for the run).

## Issue

**QA-1042 — Checkout must reject an expired credit card at the
payment step and not charge the customer.**

## Description

When a customer reaches the payment step of checkout and enters a
card whose `MM/YY` expiry is in the past, the application must:

- Reject the payment without contacting the payment processor.
- Show a clear, specific error message.
- Leave the cart contents untouched so the customer can correct the
  card and retry.

This is a regression: in the previous release a refactor accidentally
moved the expiry check downstream of the processor call. The pricing
team escalated this because a borderline-expired card was charged
once before the failure response unwound the order — partial state
in the order table is the kind of compliance issue we cannot ship.

## Acceptance criteria

1. Given a card whose expiry is in any past month (any year), when
   the customer submits the payment form, then the application
   rejects the payment client-side or at the order service
   boundary, before any processor call is made.
2. The customer sees the error message: "This card has expired.
   Please use a different card." No other error variant is
   acceptable.
3. The cart contents (items, quantities, discount code if any) are
   preserved and visible when the user returns to the cart.
4. The order log records the rejection with the reason
   `expired_card_client_reject` and `processor_called=false`.

## Risks

- High: a card is charged anyway (data integrity + compliance).
- Medium: the error message is generic and not actionable, leading
  to abandoned carts (UX regression).

## Out of scope

- Other payment methods (PayPal, Apple Pay).
- 3DS / SCA flows.
- Promo code validation logic (covered by a separate story).
- Visual styling of the error banner.
