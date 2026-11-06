# @billing/api

The NestJS application. It reads state from Postgres, asks
[`@billing/domain`](../../packages/domain) what should happen, talks to the
payment provider through [`@billing/gateway`](../../packages/gateway), and writes
the result back. It contains no billing decisions of its own.

## Layout

```
src/
  config/         environment validated once at boot (fails fast, refuses live Stripe keys)
  common/         clock, admin key guard, error-to-HTTP mapping
  prisma/         database client
  gateway/        picks the fake provider under test and Stripe otherwise
  plans/          plan catalogue and admin plan creation
  subscriptions/  checkout, status, pause, cancel
  billing/        SettlementService: records a payment result and applies its effect
  webhooks/       signature verification, deduplication, applying provider events
  renewals/       the renewal and dunning-retry job, its schedule and admin trigger
  payments/       refunds and the per-subscription ledger
prisma/           schema, migrations (with the database-level guarantees), seed
test/unit/        no database
test/e2e/         the real app against Postgres, with the fake provider
```

## Routes

| Route                                  | Who         | Purpose                                         |
| -------------------------------------- | ----------- | ----------------------------------------------- |
| `GET /health`                          | anyone      | Liveness, including a database check            |
| `GET /plans`                           | anyone      | Plans with every purchase option priced         |
| `POST /subscriptions/checkout`         | customer    | Start a subscription, get the payment page URL  |
| `GET /subscriptions/:id`               | customer    | Status, paid-through date, next retry           |
| `POST /subscriptions/:id/pause`        | customer    | Pause at the end of the paid cycle              |
| `POST /subscriptions/:id/cancel`       | customer    | Cancel at the end of the paid cycle             |
| `POST /webhooks/stripe`                | Stripe      | Provider events (signature verified)            |
| `POST /admin/plans`                    | admin key   | Create a plan and its prepaid terms             |
| `POST /admin/payments/:id/refund`      | admin key   | Refund a charge, fully or partially             |
| `GET /admin/subscriptions/:id/ledger`  | admin key   | Every charge, failure and refund, with totals   |
| `POST /admin/renewals/run`             | admin key   | Run the renewal job now                         |

Interactive docs are served at `/docs` when the app runs.

## Configuration

Copy [`.env.example`](.env.example) to `.env`. The app validates it at boot and
exits with a list of everything wrong.

| Variable                | Required              | Notes                                                           |
| ----------------------- | --------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`          | always                | `postgresql://...`                                              |
| `STRIPE_SECRET_KEY`     | outside `NODE_ENV=test` | Test-mode keys only (`sk_test_...`); live keys are refused    |
| `STRIPE_WEBHOOK_SECRET` | outside `NODE_ENV=test` | `whsec_...`, from `stripe listen`                             |
| `ADMIN_API_KEY`         | outside `NODE_ENV=test` | 16+ characters; sent as the `x-admin-key` header              |
| `PORT`                  | no                    | Default 3000                                                    |
| `APP_BASE_URL`          | no                    | Where checkout redirects to                                     |
| `RENEWAL_JOB_ENABLED`   | no                    | Default true; set false on replicas that should not run the job |

## Tests

```bash
pnpm --filter @billing/api test        # unit tests, no database
pnpm --filter @billing/api test:e2e    # needs `docker compose up -d`
```
