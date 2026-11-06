# 0007. Webhooks: atomic deduplication, state from events not order

**Status:** accepted

## Context

Providers deliver webhooks at least once, sometimes twice at the same moment,
and not always in the order things happened. A handler that counts events or
trusts their order will double-apply a payment, or move a recovered customer
back to `past_due` because an old failure turned up late.

## Decision

1. **Verify first.** The signature is checked over the raw request body. A bad
   signature is the only `400`; everything accepted answers `2xx` so the
   provider stops retrying.
2. **Deduplicate and apply in one transaction.** The event id is inserted with
   insert-or-skip in the same transaction as the event's effects. A duplicate
   (even a concurrent one) finds the row and does nothing. If processing fails,
   nothing is stored, and the provider's retry processes it from scratch.
3. **Decide from the event's content, not its position.** Each payment carries its
   attempt number and due date. `settleFailure` ignores a failure for a period
   that has since been paid, for an attempt already counted, or for an older due
   date (`packages/domain/src/settlement.ts`).
4. **One writer per subscription.** Settlement takes a row lock, so webhooks, the
   renewal job and customer actions queue up and never interleave.

## Consequences

- Two declines and a late payment delivered in all six possible orders, each event
  twice, always end in the same state (an e2e test).
- Recording is shared with the renewal job: whichever of the two sees a payment
  first records it, and the other is a no-op.
- Not handled, on purpose: refunds made in the Stripe dashboard and disputes.
  The README lists these as out of scope.
