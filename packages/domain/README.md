# @billing/domain

Every billing rule in the engine, as pure functions. No NestJS, no Prisma, no
Stripe, and no runtime dependencies at all: ESLint fails the build if this package
imports any of them. Why: [decision 0003](../../docs/decisions/0003-pure-domain-package.md).

Because nothing here touches a database, a clock or the network, each rule is
tested directly, including the edge cases that are hard to reach any other way.
Coverage is 100% and CI enforces it.

## What is in it

| File                                  | What it decides                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| [`cycle.ts`](src/cycle.ts)            | The period a payment covers: first payment anchors, early continues, late restarts |
| [`pricing.ts`](src/pricing.ts)        | Prepaid term price, with one discount on the gross amount                          |
| [`money.ts`](src/money.ts)            | Integer-cent validation and exact basis-point rounding                             |
| [`state-machine.ts`](src/state-machine.ts) | The table of legal subscription status changes; anything else throws         |
| [`dunning.ts`](src/dunning.ts)        | Retry schedule (+1, +3, +7 days from the due date) and when to give up             |
| [`lifecycle.ts`](src/lifecycle.ts)    | When a pause or cancel takes effect; what the renewal job should do right now      |
| [`settlement.ts`](src/settlement.ts)  | What a payment result means for a subscription, safe for duplicates and reordering |
| [`refunds.ts`](src/refunds.ts)        | How much a refund may refund                                                       |
| [`ledger.ts`](src/ledger.ts)          | Totals of money actually moved                                                     |
| [`keys.ts`](src/keys.ts)              | Idempotency keys, derived from state                                               |

## Example

```ts
import { periodForPayment, priceTerm, termLabel } from '@billing/domain';

priceTerm({ priceCents: 4900, cycles: 3, discountBps: 1000 });
// { grossCents: 14700, discountCents: 1470, totalCents: 13230 }

termLabel(3, 28); // "12 weeks"

// A payment that arrives after the cycle ended restarts at the payment date.
periodForPayment({
  paidAt: new Date('2026-02-05T00:00:00Z'),
  paidThrough: new Date('2026-02-01T00:00:00Z'),
  cycleDays: 28,
  cycles: 1,
});
// { start: 2026-02-05T00:00:00Z, end: 2026-03-05T00:00:00Z }
```

## Tests

```bash
pnpm --filter @billing/domain test:cov
```
