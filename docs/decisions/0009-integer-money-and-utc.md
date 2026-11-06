# 0009. Integer money and UTC timestamps

**Status:** accepted

## Context

Floating-point money produces totals that are off by a cent, and local-time
dates produce cycles that are an hour short twice a year.

## Decision

- Amounts are **integers in minor units** (cents), validated at every boundary.
  Discounts are **basis points** (1000 = 10%), applied once to the gross term
  amount and rounded half up with integer arithmetic only (`money.ts`).
- Every timestamp is UTC (`timestamptz` in Postgres, `Date` in code), and time
  arithmetic is millisecond addition.
- Time is injected (`Clock`), so every rule can be tested at a chosen instant.

## Consequences

- Totals are exact, and a prepaid term is never a cent off because of per-cycle
  rounding (a test pins this).
- Amounts are stored as 32-bit integers, which caps a single amount at about
  21 million major units. Plenty for subscriptions; worth widening for anything else.
- The engine assumes a currency with two decimal places. Zero-decimal currencies
  such as the yen would need an exponent per currency.
