# Phase 1.5 — Plain-Language Summary

## What Phase 1.5 added

Phase 1 taught the system to test what a user **sees and clicks** (the
website screens). Phase 1.5 taught it to also test what happens **behind
the scenes** — the "API," the part of a product that moves and stores data
without any screen involved.

Think of an online store: Phase 1 checks that the login page works when you
click it. Phase 1.5 checks that the store's behind-the-scenes system
correctly creates a new account and correctly refuses a sign-up that's
missing a password — even though no human ever sees those steps on a screen.

## How it works, in plain terms

When the system plans its tests, it now sorts each test into one of two
lanes:

- **Screen tests** — drive a real browser, click through the website
  (this is the Phase 1 capability).
- **Behind-the-scenes tests** — send requests straight to the product's
  data system and check the answers come back correct.

Both lanes run, and the system merges everything into **one report** that
says, across both, whether the feature is safe to release. The same four
human approval checkpoints apply to both lanes.

## What we actually did in Phase 1.5

- We ran one feature — "account access and provisioning" — through **both
  lanes at once**:
  - The **screen lane** tested signing in on a demo shopping site
    (Saucedemo): a valid login works, and a wrong password is refused
    without creating a session.
  - The **behind-the-scenes lane** tested a demo data service
    (reqres.in): creating a user succeeds, and a sign-up missing its
    password is correctly refused.
- **Every test passed** in both lanes. The system produced one combined
  report covering both.
- A human approved every checkpoint, on both lanes.

## The moment that proved the safety design works

The system has a strict rule: **never write a test from a description
alone — always check the real thing first.** That rule earned its keep in
this phase. The demo data service had quietly changed its rules to require
a security key. The test plan, written from the feature description, didn't
know that. But when the system went to verify the real behind-the-scenes
service before writing its tests, it immediately hit the new requirement —
and stopped to ask, instead of shipping tests that were quietly wrong.

That's the whole point of the design: the machine checks reality before it
commits, and it surfaces surprises to a human rather than papering over
them.

## A couple of honest notes

- Because our practice "screen" and "behind-the-scenes" targets are two
  separate demo services (not one real product), this run stitched them
  together for practice. A real product would have both in one place.
- A security key got recorded in a local results file (kept off the shared
  repository). It's flagged to be cleaned up automatically in the next
  phase, and the demo key will be rotated.

## Bottom line

The system can now test both the visible screens and the invisible
behind-the-scenes data systems of a product, and report on both together —
still with a human in control at every important step. The next phase wires
this into automated build pipelines and connects it to the team's issue
tracker.
