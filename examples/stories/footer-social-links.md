# Footer shows social links and a copyright line (STORY-021)

> Manual-mode **lite-track** story. Targets the SauceDemo shopping demo
> app (https://www.saucedemo.com). The Analyst should treat this as
> `source: "manual"` and produce `context.json` with
> `story.id = "STORY-021"` and propose `track: "lite"` — this is a
> genuinely routine, low-risk cosmetic/informational change with no
> Red-taxonomy exposure (no money, security, permissions, or data
> integrity), so its track floor is `lite` (verified via
> scripts/track-floor.js). It exists to exercise the lite track on a
> REAL story rather than a synthetic fixture.

## Goal

The footer at the bottom of the inventory page presents the company's
social media links (Twitter/X, Facebook, LinkedIn) and a copyright line,
so a shopper can reach the brand's social presence and see the site is
current.

## Acceptance criteria

1. Given a signed-in shopper on the inventory page, when they view the
   footer, then it shows three social links — Twitter/X, Facebook, and
   LinkedIn — each pointing at the corresponding saucelabs social page.
2. Given the inventory page footer, when it is displayed, then it shows a
   copyright line that includes the current four-digit year and the
   "Sauce Labs" name.

## Out of scope

- The visual styling, ordering, or icon design of the footer.
- Footer behavior on pages other than the inventory page.
- Whether the external social pages themselves load (only that the links
  point at the correct destinations).
- Localization of the copyright text.

## Notes for the QA pipeline

- This is deliberately small and low-risk — the lite track is the point.
  The reduced ceremony thins prose, NOT rigor: every case still gets an
  automation decision with a real reason, schema validation, and
  traceability. Gates 1 and 2 consolidate into one `qa_scope_approved`
  decision (lite track); Gates 3 and 4 stay separate.
- Both ACs are observable UI assertions on the rendered footer →
  `automate_e2e`. AC 1 checks the link `href` destinations; AC 2 checks
  the copyright text. The Planner/Generator should read the live footer
  rather than assume hrefs from the story text.
- Standard SauceDemo user `standard_user` / `secret_sauce`, base URL
  https://www.saucedemo.com.
