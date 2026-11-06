# Security policy

This repository is a **reference implementation** of subscription billing. It is
built to be read, run and learned from, and it works in Stripe **test mode only**:
the API refuses to start with a live key.

## Reporting a vulnerability

Please report problems privately through GitHub:
**Security → Report a vulnerability** on this repository
(<https://github.com/TTB8/subscription-billing-engine/security/advisories/new>).
Do not open a public issue for a vulnerability.

Useful reports include the affected file, what an attacker can do, and a
failing test or request that shows it. Expect an acknowledgement within a week.

## What is in scope

- Webhook handling: signature verification, deduplication, replay
- Idempotency: anything that could charge or refund twice
- The ledger: anything that lets a row be changed, removed or double counted
- Configuration: anything that lets a live key or secret be used or leaked

## Known limits (not vulnerabilities)

These are deliberate omissions in a reference project, listed in the README under
"Out of scope": customer authentication on subscription routes (the subscription
id is the only credential), operator accounts (admin routes use one shared key),
and rate limiting. If you adapt this code for production, these need real
solutions first.

## Secrets

Never commit a `.env` file or a real key. The repository ignores `.env`, and
`.env.example` contains no values.
