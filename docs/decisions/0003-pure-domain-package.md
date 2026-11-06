# 0003. All billing rules live in a pure domain package

**Status:** accepted

## Context

Billing bugs are expensive and subtle, and they hide in the seams: a discount
rounded in the controller, a state change written next to a database call, a
retry date computed in a job. Rules mixed with framework code can only be tested
through the framework.

## Decision

Every billing rule is a pure function in `packages/domain`: cycle maths, term
pricing, the subscription state machine, the dunning schedule, pause and cancel
timing, refund limits, ledger totals, and settlement (what a payment result means
for a subscription). The package has **no runtime dependencies**, and an ESLint
rule (`no-restricted-imports`) fails the build if it imports NestJS, Prisma or
Stripe.

The API layer reads a snapshot from the database, calls a domain function, and
writes the result back. It contains no billing decisions.

## Consequences

- The domain has 100% coverage with fast unit tests, including edge cases that
  would need a database or a clock to reach any other way.
- The rules read as a specification. Someone who does not know NestJS can review them.
- The cost is mapping: snapshot and patch types sit between the database rows and
  the rules (`settlement.ts`).
