# @billing/gateway

The contract between the billing engine and a payment provider, and two
implementations of it. Why this shape:
[decision 0004](../../docs/decisions/0004-gateway-interface-and-fake.md) and
[decision 0008](../../docs/decisions/0008-provider-outcomes.md).

| Piece                                          | Purpose                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| [`PaymentGateway`](src/types.ts)               | Customers, hosted checkout that saves the card, off-session charges, refunds, webhook parsing |
| [`StripeGateway`](src/stripe-gateway.ts)       | Production implementation on the Stripe SDK; every mutating call carries an idempotency key |
| [`FakeGateway`](src/fake-gateway.ts)           | In-memory implementation for tests, faithful to the behaviour billing relies on |

## Three outcomes, not two

A declined card is a normal **result** (`{ status: 'failed', failureCode }`). A
network failure or provider error is an **exception** (`GatewayUnavailableError`)
meaning *the outcome is unknown*: record nothing and repeat the call with the same
idempotency key. Anything else (`GatewayError`) is a rejected request that needs a
person. Callers must keep these apart.

## Using the fake in a test

```ts
const gateway = new FakeGateway();

gateway.script('pm_flaky', [{ decline: 'card_declined' }], 'ok'); // declines once, then works
const first = await gateway.chargeOffSession({ /* ... */ paymentMethodRef: 'pm_flaky' });
// first.status === 'failed'

gateway.loseNextResponse();          // the provider charges, but the answer never arrives
await expect(gateway.chargeOffSession(input)).rejects.toThrow(GatewayUnavailableError);
await gateway.chargeOffSession(input); // same key: replays the first charge, never a second
```

It also simulates outages, refunds that exceed the charge, and HMAC-signed
webhooks (`gateway.sign(event)`), and `reset()` clears everything between tests.

## Tests

```bash
pnpm --filter @billing/gateway test:cov
```

The Stripe implementation is tested against the real SDK types and the real
webhook signature verification, with no network calls.
