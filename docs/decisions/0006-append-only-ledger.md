# 0006. An append-only ledger, with guarantees in the database

**Status:** accepted

## Context

Every charge, failure and refund must be auditable, and the ledger must still be
right when application code has a bug. Guarantees enforced only in application
code are only as good as every code path that touches the table.

## Decision

The `Payment` table is the ledger. Rows are only ever inserted. The database
itself enforces the rules (see the first migration):

- a trigger rejects every `UPDATE` and `DELETE`;
- a unique idempotency key and a unique provider reference;
- a partial unique index allowing **one successful charge per subscription
  period**, however many attempts were made;
- `CHECK` constraints: no negative money, attempts of at least 1, and a refund row
  must point at a charge.

A refund is a row of its own that references the charge it reverses. A second
provider payment for an already-paid operation is recorded as an extra charge
with no coverage, so the surplus is visible and refundable instead of silently
dropped.

## Consequences

- History cannot be rewritten, by a bug or by a person with the application's
  credentials. Corrections are new rows.
- The partial index and trigger are raw SQL in the migration, which Prisma cannot
  express in its schema file. The e2e tests check each one against Postgres.
