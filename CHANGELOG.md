# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-06

First public version.

### Added

- Fixed-day billing cycles anchored to the first successful payment, prepaid
  multi-cycle terms with a single discount, and no proration.
- Subscription state machine with `pending_payment`, `active`, `past_due`,
  `paused` and `canceled`; illegal transitions throw.
- Dunning with a +1, +3, +7 day retry schedule, measured from the original due
  date; a late payment restarts the cycle at the payment date.
- Pause and cancel that take effect at the end of the paid cycle.
- Idempotent renewal job: repeated runs, overlapping runs and lost provider
  responses never charge twice.
- Idempotent Stripe webhook handling: verified signatures, atomic deduplication,
  safe under duplicate and out-of-order delivery.
- Append-only payments ledger with database-enforced guarantees, plus admin
  refunds (full or partial) and a per-subscription ledger view.
- `PaymentGateway` interface with `StripeGateway` and an in-memory `FakeGateway`.
- End-to-end suite against real Postgres, GitHub Actions CI, a Stripe test-mode
  walkthrough, and design decision records.
