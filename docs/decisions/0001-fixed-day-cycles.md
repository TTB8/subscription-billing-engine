# 0001. Fixed-day cycles anchored to the first payment

**Status:** accepted

## Context

"Monthly" billing is not one length. Months have 28 to 31 days, a customer who
starts on the 31st has no 31st in most months, and calendar maths depends on a
timezone and on daylight saving. Teams usually discover this as a pile of
special cases: clamped anchor days, double-billed leap days, invoices that
arrive an hour early after a clock change.

## Decision

A plan has a cycle length in **days** (default 28). A cycle starts at the instant
the customer's first payment **clears**, not on a calendar date, and each cycle
is exactly `cycleDays × 24 hours` of UTC time. Prepaid terms are named by their
length ("12 weeks", "24 weeks"), never in months.

The arithmetic is in `packages/domain/src/cycle.ts` and uses plain millisecond
addition. There is no calendar or timezone code to get wrong.

## Consequences

- No month-end, leap-year or daylight-saving cases exist. The tests
  (`packages/domain/test/cycle.spec.ts`) cover them anyway, to show they are inert.
- A 28-day cycle means **13 charges a year**, not 12. Price plans with that in mind.
- Calendar-aligned reporting (month-end revenue) has to be derived from the ledger;
  billing itself does not know about months.
- The anchor is set once and never moves, even when a late payment restarts a cycle
  (see [0002](0002-no-proration.md)).
