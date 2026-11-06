## What and why

<!-- What does this change, and what problem does it solve? -->

## Checklist

- [ ] Billing rules are in `packages/domain`, with unit tests (the domain keeps 100% coverage)
- [ ] New behaviour has an end-to-end test that goes through the public API
- [ ] Exported code has a doc comment, and any new file has a `@file` header (`pnpm lint` checks this)
- [ ] A design decision was added or updated in `docs/decisions/`, if this changes one
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:cov:api` pass
- [ ] No secrets, real card data or client names in code, tests, docs or commits
