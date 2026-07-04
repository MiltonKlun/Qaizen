# Bench Shop — a local, mutable benchmark target

A minimal, self-contained shop app served locally so the pipeline-vs-raw
benchmark can measure the two metrics **public SauceDemo cannot**:

- **`known_bug_catch_rate`** — inject a known bug and a test catches it _iff_ it
  goes red. Public SauceDemo has no bugs to catch, so that metric tied 1.0/1.0
  twice (`docs/evidence.md`). Here a bug is a runtime switch.
- **`selector_survival_rate`** — serve `v1` vs a drifted `v2` and measure how
  many of a test's locators still resolve. One public app version can never
  produce this number; the replay harness refuses to invent it.

No new dependencies: vanilla HTML/JS, a `node:http` server extending the
zero-dependency pattern in `examples/demo-run/serve.js`.

## Serve it

```powershell
# v1 (correct behavior) on the default port 4173
node examples/benchmark-app/serve.js --version v1 --port 4173

# v2 (drifted DOM) on another port, at the same time
node examples/benchmark-app/serve.js --version v2 --port 4174

# inject one or more bugs (repeatable --bug)
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug wrong-item-total
```

The server prints `PORT <n>` as its first stdout line (same contract as the demo
server), so a driver can read the port when `--port 0` (ephemeral) is used.

Log in with `standard_user` / `secret_sauce`. The flow mirrors SauceDemo:
login → inventory (add/remove + cart badge) → cart → checkout step one
(name/zip) → overview (Item total / Tax / Total) → complete.

> **Test-id attribute:** hooks use `data-test` (SauceDemo convention), not
> Playwright's default `data-testid`. In a spec, either use
> `page.locator('[data-test="…"]')` or set
> `use: { testIdAttribute: 'data-test' }` in the Playwright config.

## Bug switches (mutation testing)

Each bug is applied at **runtime** by the server injecting `window.__BENCH__`
into the page — there is one app source per version, never a buggy copy. A test
"catches" a bug iff it goes **red** when the bug is on and **green** when it is
off.

| `--bug <id>`         | What it does                                              | The story / risk it models          | A catching test asserts…                          |
| -------------------- | -------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| `stale-badge`        | Cart badge does not decrement on remove until a reload   | STORY-003 (documented bug)          | badge count == cart size right after a remove     |
| `wrong-item-total`   | Overview **Item total** = sum of prices **+ \$1.00**     | STORY-020 RISK-001                  | item total == sum of the line prices              |
| `inconsistent-total` | Overview **Total** ≠ Item total + Tax (off by \$0.50)    | STORY-020 RISK-002                  | total == item total + tax (integer cents)         |

Verified end-to-end: with `--bug wrong-item-total` the item total reads \$40.98
for a \$39.98 cart; `--bug inconsistent-total` shows a \$43.68 total where
\$43.18 is consistent; `--bug stale-badge` leaves the badge at 2 after removing
one of two items (a reload re-syncs it to 1 — the self-healing the story notes).
Clean (no `--bug`): item total \$39.98, tax \$3.20, total \$43.18, badge tracks
the cart.

## v1 → v2 drift (ground truth for `selector_survival_rate`)

`v2` is `v1` with realistic DOM drift so locators bound to old hooks rot. Every
change is listed here so scoring is against a known truth, not a guess.

| Surface        | v1 hook                              | v2 hook                        | Kind             |
| -------------- | ------------------------------------ | ------------------------------ | ---------------- |
| Login username | `data-test="username"`               | `data-test="user-name"`        | renamed test-id  |
| Login password | `data-test="password"`               | `data-test="pass-word"`        | renamed test-id  |
| Add-to-cart    | `data-test="add-to-cart-<id>"`       | `data-test="add-<id>"`         | renamed test-id  |
| Item price     | `data-test="inventory-item-price"`   | `data-test="item-cost"`        | renamed test-id  |
| Item total     | `data-test="subtotal-label"`         | `data-test="summary-subtotal"` | renamed test-id  |
| Price cell     | `class="item_price"`                 | `class="price-tag"`            | renamed class    |
| Page headings  | `class="title"`                      | `class="page-title"`           | renamed class    |
| Overview totals| `<div class="summary_info">` + `.summary_row` rows | `<ul class="summary-list">` + `.summary-line` items | restructured container |

**Unchanged (these hooks survive v2):** `login-button`, `title` (the
`data-test`, not the class), `error`, `shopping-cart-link`,
`shopping-cart-badge`, `checkout`, `continue`, `finish`, `firstName`,
`lastName`, `postalCode`, `tax-label`, `total-label`, `inventory-item-name`,
`remove-<id>`, `complete-header`, `cancel`, `continue-shopping`,
`back-to-products`.

## Measure selector survival

`scripts/selector-survival.js` loads each version's **landing (login) page** and
checks which of a spec's locators still resolve there, so a survival probe
should list **login-surface** hooks. `login.survival-probe.spec.ts` does exactly
that:

```powershell
# start both versions
node examples/benchmark-app/serve.js --version v1 --port 4173
node examples/benchmark-app/serve.js --version v2 --port 4174
# then, in another shell:
npm run benchmark:survival -- --tests examples/benchmark-app/login.survival-probe.spec.ts --version http://127.0.0.1:4173 --version http://127.0.0.1:4174
```

Expected: **40% survival** — `login-button` and the `title` test-id survive;
`username`, `password`, and the `.title` class do not (they were drifted in v2).
That maps 1:1 to the table above.

## Files

| Path                          | What                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `serve.js`                    | The server (`--version`, `--port`, repeatable `--bug`)     |
| `v1/index.html`               | Correct-behavior app                                       |
| `v2/index.html`               | Same app with the documented DOM drift                     |
| `login.survival-probe.spec.ts`| Login-surface locator probe for the survival script        |
