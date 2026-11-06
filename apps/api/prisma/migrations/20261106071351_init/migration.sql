-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('pending_payment', 'active', 'past_due', 'paused', 'canceled');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('charge', 'failure', 'refund');

-- CreateEnum
CREATE TYPE "StopKind" AS ENUM ('pause', 'cancel');

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "cycleDays" INTEGER NOT NULL DEFAULT 28,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanTerm" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "cycles" INTEGER NOT NULL,
    "discountBps" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "PlanTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "termCycles" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'pending_payment',
    "anchorAt" TIMESTAMPTZ(3),
    "paidThroughAt" TIMESTAMPTZ(3),
    "pendingStop" "StopKind",
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMPTZ(3),
    "nextRetryAt" TIMESTAMPTZ(3),
    "paymentMethodRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "periodStart" TIMESTAMPTZ(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "gatewayRef" TEXT,
    "failureCode" TEXT,
    "refundOfId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PlanTerm_planId_cycles_key" ON "PlanTerm"("planId", "cycles");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_stripeCustomerId_key" ON "Customer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Subscription_status_paidThroughAt_idx" ON "Subscription"("status", "paidThroughAt");

-- CreateIndex
CREATE INDEX "Subscription_status_nextRetryAt_idx" ON "Subscription"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayRef_key" ON "Payment"("gatewayRef");

-- CreateIndex
CREATE INDEX "Payment_subscriptionId_createdAt_idx" ON "Payment"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_refundOfId_idx" ON "Payment"("refundOfId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_subscriptionId_periodStart_type_attempt_key" ON "Payment"("subscriptionId", "periodStart", "type", "attempt");

-- AddForeignKey
ALTER TABLE "PlanTerm" ADD CONSTRAINT "PlanTerm_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundOfId_fkey" FOREIGN KEY ("refundOfId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Guarantees Prisma cannot express in the schema file.
-- ---------------------------------------------------------------------------

-- At most ONE successful charge per subscription period, whatever the attempt
-- number. The idempotency key stops duplicate requests; this stops a logic bug.
CREATE UNIQUE INDEX "Payment_one_charge_per_period"
  ON "Payment" ("subscriptionId", "periodStart")
  WHERE "type" = 'charge';

-- Money is never negative; cycles and discounts stay in range.
ALTER TABLE "Plan"
  ADD CONSTRAINT "Plan_priceCents_nonneg" CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "Plan_cycleDays_positive" CHECK ("cycleDays" >= 1);

ALTER TABLE "PlanTerm"
  ADD CONSTRAINT "PlanTerm_cycles_positive" CHECK ("cycles" >= 1),
  ADD CONSTRAINT "PlanTerm_discountBps_range" CHECK ("discountBps" BETWEEN 0 AND 10000);

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_termCycles_positive" CHECK ("termCycles" >= 1),
  ADD CONSTRAINT "Subscription_failureCount_nonneg" CHECK ("failureCount" >= 0);

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amountCents_nonneg" CHECK ("amountCents" >= 0),
  ADD CONSTRAINT "Payment_attempt_positive" CHECK ("attempt" >= 1),
  ADD CONSTRAINT "Payment_refund_links_charge" CHECK (("type" = 'refund') = ("refundOfId" IS NOT NULL));

-- The ledger is append-only: no updates, no deletes.
CREATE FUNCTION "payment_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payment ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Payment_append_only"
  BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "payment_is_append_only"();
