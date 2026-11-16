# BENCH-2 — Checkout and order review (SPEC-001)

Story: BENCH-2. Brief: planner-input/BENCH-2.planner-brief.md.
Seed: tests/seed.spec.ts. App: Bench Shop v1.

Every figure is read from the review; no amount is copied from the story.
As the brief records from Gate 2, the money scenarios use the one
two-product basket, and the negative scenario is the missing postcode alone;
other baskets, the tax rounding and other empty fields are out of scope.

## Scenarios

### 1. Complete delivery details reach the review (TC-001, RISK-004)

**Steps:**

1. Sign in with the demo account the sign-in screen shows.
2. Put the Bevel-Edge Chisel Set and the Brass Marking Gauge in the basket.
3. Open the basket and select "Go to checkout".
4. Enter given name Ada, family name Joiner and postcode LS6 2QT; select
   "Review order".

**Expected:** the "Review your order" heading is shown, and the review lists
the Bevel-Edge Chisel Set and the Brass Marking Gauge.

### 2. The Items figure is shown (TC-002, RISK-001)

**Steps:** reach the review as in scenario 1.

**Expected:** the review shows an "Items" figure.

### 3. The Order total is Items plus Sales tax (TC-003, RISK-002)

**Steps:** reach the review as in scenario 1; read the "Items", "Sales tax"
and "Order total" figures.

**Expected:** the "Order total" equals the shown "Items" figure plus the shown
"Sales tax", to the cent.

### 4. Delivery details without a postcode are refused (TC-004, RISK-003)

**Steps:** sign in and fill the basket as in scenario 1, go to checkout, enter
given name Ada and family name Joiner, leave the postcode empty and select
"Review order".

**Expected:** the "Delivery details" heading stays shown, the message "Please
enter a postcode." is shown, and the "Review your order" heading is not.

### 5. Placing the order confirms it and clears the basket count (TC-005, RISK-004)

**Steps:** reach the review as in scenario 1 and select "Place order".

**Expected:** the "Order placed" heading and the confirmation "Your order is
on its way to the workshop." are shown, and the basket count is no longer
shown.
