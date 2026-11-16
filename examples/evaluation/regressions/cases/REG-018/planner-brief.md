# Planner brief — BENCH-2

Story: BENCH-2, the order review shows the right items figure, sales tax and
order total. Gate 2 approved five cases, all `automate_e2e`.

| Case   | Risk     | What the spec must cover                                    |
| ------ | -------- | ----------------------------------------------------------- |
| TC-001 | RISK-004 | Complete delivery details reach the review, both products   |
| TC-002 | RISK-001 | Items equals the sum of the prices the review lists         |
| TC-003 | RISK-002 | Order total equals the shown Items plus the shown Sales tax |
| TC-004 | RISK-003 | No postcode: stays on delivery details with the message     |
| TC-005 | RISK-004 | Placing the order confirms it and clears the basket count   |

Read every figure from the screen and compute the expected values from what
it shows; the story gives no amounts. Out of scope: changing the basket during
checkout, payment, order history, how the screens look, where cancel and back
lead.

Gate 2 scope decisions: the money cases (TC-002, TC-003) use the one
two-product basket of TC-001; other baskets and the tax rounding are not in
scope (the story states no rounding rule, and Bench Shop's tax is an app
rule). TC-004 is the story's negative case; no other negative variant
(another empty field, several empty fields) is in scope.

App: Bench Shop v1 (`node examples/benchmark-app/serve.js --version v1`).
