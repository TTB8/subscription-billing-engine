# 0004. The payment provider sits behind an interface, with a fake

**Status:** accepted

## Context

The failures that matter in billing (a card declined on the third retry, a
response lost after the provider charged, the same webhook delivered five times
at once) cannot be produced on demand against a real provider. If they cannot be
produced, they are not tested.

## Decision

Billing depends on a `PaymentGateway` interface (`packages/gateway/src/types.ts`).
There are two implementations:

- `StripeGateway` for production. It maps Stripe's API and webhook events onto
  the neutral contract and sorts Stripe errors by what the caller should do
  ([0008](0008-provider-outcomes.md)).
- `FakeGateway` for tests. It reproduces the behaviour billing relies on:
  idempotent replays (and an error when a key is reused with different
  parameters), declines returned as results, scripted card outcomes, outages,
  lost responses, and HMAC-signed webhooks.

The end-to-end suite runs the real application against a real Postgres with the
fake provider.

## Consequences

- Failure scenarios are deterministic and fast: the full lifecycle suite runs in
  seconds.
- The risk is that the fake drifts from Stripe. It is contained three ways: the
  Stripe implementation is unit-tested against the real SDK types and the real
  signature verification, the fake models only documented Stripe behaviour, and
  [docs/stripe-test-mode.md](../stripe-test-mode.md) is a manual check against the
  real thing.
