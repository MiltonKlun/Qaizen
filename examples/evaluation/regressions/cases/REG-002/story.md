# Apply a coupon at checkout (STORY-102)

## Description

A shopper can enter one coupon code on the cart page. A coupon has a minimum
item total and an expiry date.

## Acceptance criteria

1. Given a valid coupon code, when the shopper applies it on the cart page, then the discount is applied only when the item total is at least $20.00 and the coupon has not expired.
2. Given an expired coupon code, when the shopper applies it, then the message "This coupon has expired." is shown and the item total is unchanged.
