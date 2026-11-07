# Free shipping over $50 (STORY-101)

## Description

Shoppers get free standard shipping on larger orders. The threshold is
compared with the item total before tax, and an order of exactly $50.00 still
pays for shipping.

## Acceptance criteria

1. Given a cart whose item total is more than $50.00, when the shopper reaches the checkout overview, then standard shipping is shown as $0.00.
2. Given a cart whose item total is $50.00 or less, when the shopper reaches the checkout overview, then standard shipping is shown as $4.99.
3. The free-shipping threshold is compared with the item total before tax.
