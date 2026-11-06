# Contributing

Thanks for reading the code. This project is a reference implementation, so the
bar for a change is that it makes the engine more correct, clearer, or better
tested. Read [docs/decisions](docs/decisions/README.md) first: some behaviours
that look like gaps (no proration, fixed-day cycles) are deliberate.

## Set up

You need Node 20+, pnpm and Docker.

```bash
docker compose up -d                       # Postgres 16 on localhost:5433
pnpm install
cp apps/api/.env.example apps/api/.env     # fill in the Stripe test keys only if you use them
pnpm db:reset                              # migrate and seed
pnpm dev
```

The test suites need no Stripe account: they use an in-memory fake provider and
the `billing_test` database that `docker compose` creates.

## Commands

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `pnpm dev`          | Build the packages and run the API with reload                        |
| `pnpm lint`         | ESLint, including the documentation rules                             |
| `pnpm format`       | Prettier (`pnpm format:check` only checks)                            |
| `pnpm typecheck`    | Strict TypeScript across every package                                |
| `pnpm test`         | Unit tests (no database)                                              |
| `pnpm test:cov`     | Unit tests with coverage; the domain and gateway enforce thresholds   |
| `pnpm test:e2e`     | End-to-end tests against Postgres, with the fake provider             |
| `pnpm test:cov:api` | API unit and e2e tests with merged coverage and a threshold floor     |

CI runs lint, formatting, typecheck and both coverage commands on Node 20 and 22.

## How the code is organized

```
packages/domain    pure billing rules: no framework, database or provider imports
packages/gateway   PaymentGateway interface, StripeGateway, in-memory FakeGateway
apps/api           NestJS app: reads state, calls the rules, writes the result
```

The most important rule: **billing decisions belong in `packages/domain`.** If a
change needs an `if` about cycles, money, states or retries, it goes there as a
pure function with unit tests, and the API calls it. ESLint stops the domain from
importing NestJS, Prisma or Stripe.

## Standards

- **Document as you write.** Every source file starts with an `@file` header
  saying what it is for, and every exported function, class, type and constant has a
  doc comment. `pnpm lint` fails if one is missing. Explain *why*, not just what.
- **Money is integer cents; time is UTC.** No floats for money, no local-time maths.
- **Test the failure, not only the success.** A new rule needs its edge cases in a
  unit test, and new behaviour needs an end-to-end test through the public API. If a
  test could pass without the code doing its job, mutate the code and check that it fails.
- **Idempotent by construction.** Anything that charges or refunds derives its
  idempotency key from state ([0005](docs/decisions/0005-derived-idempotency-keys.md)).
- **Record decisions.** A change to how the engine behaves gets a short note in
  `docs/decisions/`, or an update to an existing one.
- **Never commit secrets, real card data, a `.env` file, or the name of a client
  or employer.** Stripe test mode only.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(webhooks): add idempotent Stripe webhook handling
fix(lint): give standalone .mjs scripts the Node globals
test(e2e): add full customer lifecycle stories
docs(dx): add Stripe test-mode guide
```

Types in use: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`. One commit per
logical change, explained in the body when the reason is not obvious from the diff.

Open a pull request against `main`. The template lists what a reviewer will check.
CI must be green.

## Adding a billing rule: the usual path

1. Write the rule as a pure function in `packages/domain/src`, with a doc comment and
   a `@file` header if the file is new. Export it from `index.ts`.
2. Cover every branch in `packages/domain/test` (the domain package keeps 100%).
3. Use it from the API (usually `SettlementService`, `RenewalsService` or
   `SubscriptionsService`); the service only reads, calls and writes.
4. Add an end-to-end test that drives it through the API, with the fake provider.
5. Update `docs/decisions` if the behaviour changes a decision.
