# 0002. No proration: a cycle is the unit of sale

**Status:** accepted

## Context

Proration turns every mid-cycle event into arithmetic: a credit for unused days,
a charge for the new plan's remaining days, rounding to the cent, and a
decision about whether to refund or carry the credit. Each of those is a place
for a customer to be charged the wrong amount, and each needs provider calls
and ledger entries to explain.

## Decision

Nothing is prorated. A cycle begins when payment clears and is sold whole.

- **A late payment restarts the cycle at the payment date.** The customer never
  pays for days they had no coverage, and the old schedule position is forgotten.
- **Pause and cancel take effect at the end of the paid cycle**, or immediately
  when nothing is paid forward (unpaid checkout, `past_due`).
- **Cancelling never refunds.** The customer keeps what they paid for. A refund is a
  separate, explicit admin action ([0006](0006-append-only-ledger.md)).

The rules are `periodForPayment` (`cycle.ts`) and `resolveStop` (`lifecycle.ts`).

## Consequences

- Nothing is ever owed back automatically, so the ledger only ever contains
  charges, failures and explicit refunds.
- A customer who cancels on day 3 has 25 days left, which is the product working as
  designed. A business that wants goodwill refunds issues them deliberately.
- Changing plan in the middle of a cycle is not supported; it would be done at the
  next renewal.
