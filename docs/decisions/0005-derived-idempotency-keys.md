# 0005. Idempotency keys are derived from state, never random

**Status:** accepted

## Context

A renewal job will be run twice, will overlap with itself on two servers, and will
sometimes charge a card and then lose the response. A random or time-based
idempotency key makes every one of those a double charge, because each retry
looks like a new request.

## Decision

Keys are a pure function of what is being paid for (`packages/domain/src/keys.ts`):

```
charge:<subscription>:<due date>:<attempt>
refund:<charge>:<position among that charge's refunds>
```

The job recomputes the key from stored state on every run, so any repeat of the
same operation sends the provider the same key and gets the same payment back.
Locks are held to decide and to record, never across the provider call.

## Consequences

- Repeated runs, overlapping runs and retries after a lost response all charge
  once. The tests hold two runs at the provider at the same moment to prove it, and
  mutation-testing the key (adding the current time) makes three tests fail.
- The key identifies the operation, not its parameters. If a plan's price changes
  between a lost response and its retry, the provider rejects the repeat. That is
  surfaced for a person to look at, never resolved by charging again
  ([0008](0008-provider-outcomes.md)).
