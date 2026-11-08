# Bench Shop — a local, mutable benchmark target

A small workshop-tools store served locally so the pipeline-vs-raw benchmark
can measure the two metrics **public SauceDemo cannot**:

- **`known_bug_catch_rate`**: inject a known bug, and a test catches it _iff_
  it goes red. Public SauceDemo has no bugs to catch, so that metric tied
  1.0/1.0 twice (`docs/evidence.md`). Here a bug is a runtime switch.
- **`selector_survival_rate`**: serve the `v1` baseline and a drifted `v2`
  and measure how many reviewed probes still find their one usable target.
  One public app version can never produce this number; the harness refuses
  to invent it.

**Its own app, not a copy.** The products, prices, tax rule, sign-in
details, routes, screen text and hooks are Bench Shop's own. Until
2026-11-08 the app mirrored SauceDemo (its products, prices, tax rate,
sign-in details and hook names), which a model can recall from its training data: a
text-only arm could then write a passing test without looking at the app. A
test (`test/benchmark-app.test.js`) now fails if any SauceDemo name, price,
credential, hook or screen text comes back here, in the stories under
`stories/`, or in the regression cases that run on it. No benchmark record
was measured on the old app (`docs/evidence.md` §5d).

No new dependencies: vanilla HTML/JS, served by the zero-dependency static
server the demo app also uses (`examples/shared/static-server.js`).

**One app, two versions.** `app/shop.js` holds all of the behavior (router,
basket, bug switches, money math), so a change there reaches every version.
`app/versions.js` holds only what differs between versions: the drift below,
and nothing else.

## Serve it

```powershell
# v1 (correct behavior) on the default port 4173
node examples/benchmark-app/serve.js --version v1 --port 4173

# v2 (drifted DOM) on another port, at the same time
node examples/benchmark-app/serve.js --version v2 --port 4174

# inject one or more bugs (repeatable --bug)
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug wrong-item-total
```

The server prints `PORT <n>` as its first stdout line (same contract as the
demo server), so a driver can read the port when `--port 0` (ephemeral) is
used.

The sign-in screen shows the demo account (workshop ID `ada.joiner`,
passphrase `dovetail-42`). The flow: sign in → catalogue (add / take out, and
the basket count in the header) → basket → delivery details (given name,
family name, postcode) → review your order (Items / Sales tax / Order total)
→ order placed.

| Product               | Hook id         | Price  |
| --------------------- | --------------- | ------ |
| Bevel-Edge Chisel Set | `chisel-set`    | $34.50 |
| Brass Marking Gauge   | `marking-gauge` | $12.25 |
| Low-Angle Block Plane | `block-plane`   | $58.75 |

**Sales tax** is 6.5% of the Items figure, rounded half up to the cent. A good
test reads the figures the review shows; it never assumes the rule.

> **Hook attribute:** hooks use `data-qa`, not Playwright's default
> `data-testid`. In a spec, use `page.locator('[data-qa="…"]')`, or set
> `use: { testIdAttribute: 'data-qa' }` in the Playwright config.

## Bug switches (mutation testing)

Each bug is applied at **runtime** by the server injecting `window.__BENCH__`
into the page: there is one app source per version, never a buggy copy. A
test "catches" a bug iff it goes **red** when the bug is on and **green** when
it is off.

| `--bug <id>`         | What it does                                                      | The story / risk it models | A catching test asserts…                         |
| -------------------- | ----------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| `stale-badge`        | The basket count does not go down on a take-out until a new screen | `stories/BENCH-1.md` RISK-001 | the count equals the basket size right after a take-out |
| `wrong-item-total`   | The review's **Items** figure = sum of prices **+ \$1.00**        | `stories/BENCH-2.md` RISK-001 | Items == the sum of the line prices             |
| `inconsistent-total` | The **Order total** ≠ Items + Sales tax (off by \$0.50)           | `stories/BENCH-2.md` RISK-002 | Order total == Items + Sales tax (in cents)      |

`npm run benchmark:check` verifies them in a browser: it buys the chisel set
and the marking gauge, takes one out, moves on, puts it back and checks out,
clean and with each bug, and fails unless each bug changes only its own
symptom (`scripts/lib/bench-shop-check.js`). Clean: Items \$46.75, Sales tax
\$3.04, Order total \$49.79, and the count reads 2, then 1 after the take-out
and after moving on. With
`wrong-item-total` Items reads \$47.75; with `inconsistent-total` the Order
total reads \$50.29; with `stale-badge` the count stays at 2 after a take-out
and is right again on the next screen.

## v1 → v2 drift (ground truth for `selector_survival_rate`)

`v2` is `v1` with realistic DOM drift so locators bound to old hooks rot.
Every change is listed here so scoring is against a known truth, not a guess.

| Surface            | v1 hook                                  | v2 hook                                | Kind                   |
| ------------------ | ---------------------------------------- | -------------------------------------- | ---------------------- |
| Sign-in user       | `data-qa="login-user"`                   | `data-qa="signin-user"`                | renamed hook           |
| Sign-in passphrase | `data-qa="login-pass"`                   | `data-qa="signin-pass"`                | renamed hook           |
| Add to basket      | `data-qa="basket-add-<id>"`              | `data-qa="put-in-<id>"`                | renamed hook           |
| Product price      | `data-qa="product-price"`                | `data-qa="unit-price"`                 | renamed hook           |
| Items figure       | `data-qa="sum-items"`                    | `data-qa="items-sum"`                  | renamed hook           |
| Price cell         | `class="price"`                          | `class="cost"`                         | renamed class          |
| Screen headings    | `class="heading"`                        | `class="screen-heading"`               | renamed class          |
| Review totals      | `<div class="order-sums">` + `.sum-row`  | `<table class="order-table">` + `.order-line` | restructured container |
| Review lines       | `<div id="review-lines">`                | `<section id="review-lines">`          | changed element        |

No v1 hook contains its v2 name, so a check that a repair uses the v2 hook
cannot be met by code that still uses the v1 one. In both versions the review
figures are `<span>` elements carrying their hooks; v2 only wraps them in
table cells.

**Review labels (both versions):** each figure is one element whose text
carries its label (`Items: $…`), so a text locator for it matches one
element.

**Unchanged (these hooks survive v2):** `login-submit`, `page-heading` (the
hook, not the class), `form-error`, `demo-account`, `basket-link`,
`basket-count`, `basket-remove-<id>`, `product-name`, `keep-shopping`,
`go-to-checkout`, `given-name`, `family-name`, `postcode`, `back-to-basket`,
`review-order`, `sum-tax`, `sum-total`, `cancel-order`, `place-order`,
`order-confirmed`, `shop-again`. The field labels ("Workshop ID",
"Passphrase", ...) are unchanged too.

## Measure selector survival

`scripts/selector-survival.js --probe` runs reviewed probe functions (the
exact locators, plus the preparation they need) on a named baseline and on
each later version. A probe survives only when it still finds exactly one
usable target (`scripts/lib/selector-probes.js`).
`probes/login-surface.probe.mjs` probes five sign-in-screen locators on the
landing page:

```powershell
# start both versions
node examples/benchmark-app/serve.js --version v1 --port 4173
node examples/benchmark-app/serve.js --version v2 --port 4174
# then, in another shell:
npm run benchmark:survival -- --probe examples/benchmark-app/probes/login-surface.probe.mjs --baseline v1=http://127.0.0.1:4173/ --version v2=http://127.0.0.1:4174/
```

Measured: **2/5 = 40% survival**. The `login-submit` and `page-heading` hooks
each still find one usable target; `login-user`, `login-pass` and the
`.heading` class find none (they drifted in v2). That maps 1:1 to the table
above. Every probe resolves its unique target on v1 first; if one did not, or
the page could not be prepared, the rate would be null with the reason.

`npm run benchmark:check` does all of this in one command (servers on
ephemeral ports) and fails unless the result matches the drift table and
every seeded bug toggles; CI runs it in the Playwright job. Run it before any
benchmark series, and record the commit you measured (`--app bench-shop@v1
--app-commit <sha>` to `npm run benchmark:capture`).

## Files

| Path                             | What                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `serve.js`                       | The server (`--version`, `--port`, repeatable `--bug`)                       |
| `app/index.html`                 | The page shell (styles, header, script tags)                                 |
| `app/shop.js`                    | The shared behavior of every version                                         |
| `app/versions.js`                | The only differences between versions: the drift table                       |
| `probes/login-surface.probe.mjs` | Reviewed sign-in probes (typechecked; run by `npm run benchmark:check`)      |
| `stories/BENCH-1.md`, `BENCH-2.md` | The stories a series runs on Bench Shop, one per seeded bug family        |
