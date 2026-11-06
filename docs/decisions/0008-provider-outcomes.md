# 0008. Three kinds of provider outcome, three different reactions

**Status:** accepted

## Context

"The charge did not work" covers three different situations that need three
different reactions. Treating them alike either cancels customers over a network
blip or charges them twice.

## Decision

| Outcome | Example | Representation | Reaction |
| --- | --- | --- | --- |
| **Declined** | insufficient funds, expired card | a normal `ChargeResult` with `status: 'failed'` | record the failure, start or continue dunning |
| **Unknown** | timeout, connection reset, 5xx, rate limit | `GatewayUnavailableError` | record **nothing**; the next run repeats the same charge with the same key |
| **Rejected** | invalid request, bad configuration, idempotency key reused with different parameters | `GatewayError` | report for a person to look at; **never** dun or cancel the customer |

## Consequences

- A provider outage cannot cancel anyone and cannot double charge anyone.
- A bug or misconfiguration leaves the affected subscription untouched and logs an
  error on every run until someone fixes it. That is deliberately loud: it is
  better to be noisy than to cancel a customer by mistake.
- The HTTP layer maps these the same way: provider details are logged, never
  returned to the caller.
