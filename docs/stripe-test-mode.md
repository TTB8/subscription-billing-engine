# Trying it with Stripe test mode

The automated tests run against an in-memory fake of the payment provider, so
they need no Stripe account. This guide is the manual check of the **real**
integration: real Stripe API calls, real webhook signatures, real decline codes.

Everything here uses Stripe **test mode**. The API refuses to boot with a live
key (`sk_live_...`), so you cannot charge real money by accident.

## What you need

- A Stripe account (test mode is on by default for a new account)
- The [Stripe CLI](https://docs.stripe.com/stripe-cli), signed in with `stripe login`
- Docker, Node 20+ and pnpm

## 1. Configure

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env`:

| Variable                | Value                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Your test secret key (`sk_test_...`), from the Stripe dashboard → Developers |
| `ADMIN_API_KEY`         | Any random string of 16+ characters, e.g. `openssl rand -hex 24`           |
| `STRIPE_WEBHOOK_SECRET` | Filled in at step 2                                                         |

## 2. Forward webhooks to your machine

In a separate terminal, start the Stripe CLI listener. Only two event types matter to the engine:

```bash
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed \
  --forward-to localhost:3000/webhooks/stripe
```

It prints a signing secret (`whsec_...`). Put it in `STRIPE_WEBHOOK_SECRET`.
Leave the listener running; every event it forwards is printed with the HTTP
status the engine returned.

## 3. Start the engine

```bash
docker compose up -d
pnpm install
pnpm db:reset        # applies the migration and seeds two plans
pnpm dev
```

API docs are at <http://localhost:3000/docs>.

For the commands below:

```bash
export API=http://localhost:3000
export ADMIN_API_KEY=<the value from apps/api/.env>
```

## 4. First payment (card `4242 4242 4242 4242`)

```bash
curl -s $API/plans                      # pick a plan id
curl -s -X POST $API/subscriptions/checkout \
  -H 'content-type: application/json' \
  -d '{"email":"ana@example.test","planId":"<plan id>"}'
```

Open the returned `checkoutUrl` and pay with:

- Card `4242 4242 4242 4242`, any future expiry, any CVC

The success page after paying does not exist (this repo is the API only), so a
404 in the browser is expected. What matters is the listener terminal: you
should see `payment_intent.succeeded` forwarded and answered `200`.

```bash
curl -s $API/subscriptions/<subscription id>
```

The subscription is `active`, `anchorAt` is the moment the payment cleared, and
`paidThroughAt` is exactly 28 days later.

## 5. A renewal

A real renewal happens 28 days from now. To see it now, pretend the cycle just ended:

```bash
scripts/demo.sh make-due <subscription id>
scripts/demo.sh renew
scripts/demo.sh ledger <subscription id>
```

(The job also runs by itself every five minutes, so it may get there first.)

The ledger now has a second charge. In the Stripe dashboard, the new payment is
an off-session PaymentIntent whose metadata names the subscription and the
attempt. The listener shows `payment_intent.succeeded` answered `200` with no
effect: the job had already recorded that payment.

## 6. A renewal that fails

Stripe documents card `4000 0000 0000 0341` as one that **attaches** to a
customer but whose **charges fail**. In this engine the first payment goes
through Checkout, which charges the card immediately, so that card would be
declined at checkout rather than at renewal.

To simulate "works at first, fails at renewal", swap the saved card after the
first payment. Find the customer id, attach Stripe's failing test payment
method to it, and save the new payment method on the subscription:

```bash
scripts/demo.sh show <subscription id>           # note stripeCustomerId (cus_...)
stripe payment_methods attach pm_card_chargeCustomerFail -d customer=<cus_...>
                                                  # note the new payment method "id" (pm_...)
scripts/demo.sh swap-card <subscription id> <pm_...>
scripts/demo.sh make-due <subscription id>
scripts/demo.sh renew
```

Expected: the summary reports `"failed": 1`. Then:

```bash
curl -s $API/subscriptions/<subscription id>
```

The subscription is `past_due`, `paidThroughAt` has not moved, and
`nextRetryAt` is one day after the due date. The ledger has a `failure` entry
with Stripe's decline code.

Walk the retry schedule (+1, +3, +7 days after the due date):

```bash
scripts/demo.sh retry-now <subscription id>
scripts/demo.sh renew
```

Repeat. After the fourth failed attempt the subscription becomes `canceled` and
is never charged again.

## 7. Recovery

Before the schedule runs out, give the subscription a good card and retry:

```bash
stripe payment_methods attach pm_card_visa -d customer=<cus_...>
scripts/demo.sh swap-card <subscription id> <new pm_...>
scripts/demo.sh retry-now <subscription id>
scripts/demo.sh renew
```

The subscription returns to `active`. Look at `paidThroughAt`: the new cycle
starts **at the moment this payment cleared**, not at the old due date. A late
payment restarts the cycle; nothing is prorated or owed back.

## 8. Refund, pause and cancel

```bash
# Refund part of a charge (use a charge id from the ledger; omit amountCents for a full refund)
curl -s -X POST $API/admin/payments/<charge id>/refund \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"amountCents":1000}'

# Cancel at the end of the paid cycle (nothing is refunded)
curl -s -X POST $API/subscriptions/<subscription id>/cancel
```

The refund appears in the ledger and in the Stripe dashboard. Cancelling a
subscription that has paid time left only schedules the cancel
(`pendingStop: "cancel"`); it takes effect at `paidThroughAt`.

## Test values used

| Purpose                              | Value                                         |
| ------------------------------------ | --------------------------------------------- |
| Successful card                      | `4242 4242 4242 4242`, any future date, any CVC |
| Successful saved payment method      | `pm_card_visa`                                |
| Attaches fine, every charge declines | `pm_card_chargeCustomerFail` (card `4000 0000 0000 0341`) |

## Troubleshooting

- **Listener shows `400` for every event.** `STRIPE_WEBHOOK_SECRET` does not match
  the secret the listener printed. Restart the API after changing it.
- **The API exits at startup.** It lists every missing or invalid setting. A
  `sk_live_` key is refused on purpose.
- **`401` from admin routes.** Send the `x-admin-key` header with your `ADMIN_API_KEY`.
- **Nothing happens on `renew`.** Check `scripts/demo.sh show`: only `active`
  subscriptions with a past `paidThroughAt`, or `past_due` ones with a past
  `nextRetryAt`, are charged.

## What the real integration does not cover

This repo deliberately leaves out: collecting a replacement card from the
customer (a Stripe SetupIntent flow, which is why step 6 swaps the card with
SQL), refunds made in the Stripe dashboard, and chargebacks. See the README's
"Out of scope" section.
