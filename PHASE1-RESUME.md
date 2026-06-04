# Phase 1 — Plain-Language Summary

## What this system is

It's an assistant that does software quality testing for you, with a human
always checking its work at the important moments.

You give it a feature request (for example: "users should be able to log in").
It figures out what could go wrong, writes a checklist of tests, builds those
tests, runs them against the real website, and hands you back a clear report
saying whether the feature is safe to release — and if not, why.

Think of it as a very thorough, very fast QA tester that never skips steps and
never hides a problem, but always asks for your sign-off before moving forward.

## How it works, in five plain steps

1. **Understand the request.** It reads the feature description and lists what
   the feature must do and what could go wrong.
2. **Plan the tests.** It writes a checklist of things to verify, and decides
   for each one the smartest way to test it.
3. **Build the tests.** It opens the real website, clicks through it like a
   user would, and writes automated tests based on what it actually sees (not
   on guesses).
4. **Run and check.** It runs the tests and sorts any problems into "safe to
   auto-fix later," "needs a human to look," or "this is a real bug."
5. **Report.** It produces a short report: did it pass, what's still pending,
   and what to do next.

## The safety rule that makes it trustworthy

At four key moments, the system **stops and waits for a human to approve**
before continuing:

1. After it understands the request.
2. After it plans the tests.
3. After it designs how the tests will work.
4. After it writes the actual test code.

That last check — reviewing the test code — is **always done by a person and
will never be automated.** This is on purpose: it's what keeps a machine from
quietly shipping something wrong.

## What we actually did in Phase 1

Phase 1 was about building the foundation and proving the whole thing works
end-to-end, once, on a real website.

- We chose a public demo shopping site (**Saucedemo**) to test against.
- We ran one real feature through the entire system: **"a user can log in."**
- The system understood it, planned the tests, explored the live site, wrote
  the tests, ran them, and produced a report.
- **All the tests passed.** The system correctly confirmed that valid logins
  work and that wrong passwords are properly rejected without creating a
  fake login session.
- A human approved every one of the four checkpoints along the way.

## What's left for later (on purpose)

Two checks were planned but deliberately postponed — these aren't problems,
they're scheduled for the next phases:

- One check needs to talk to a website's behind-the-scenes data system. The
  demo site doesn't have one, so we'll do this in the next phase against a
  different practice service.
- One check is a visual "does this look right to a human" review, which a
  person will do by eye.

## Bottom line

Phase 1 proved the machine can take a feature request and walk it all the way
to a trustworthy test report, with a human in control at every important step.
The foundation is solid and working. The next phase adds the ability to test a
website's behind-the-scenes data systems, not just the screens people see.
