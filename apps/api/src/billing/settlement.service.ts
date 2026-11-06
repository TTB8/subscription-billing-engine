import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chargeIdempotencyKey, settleFailure, settleSuccess } from '@billing/domain';

/** What the provider reported about one payment attempt. Webhooks and the renewal job both produce this. */
export interface PaymentOutcome {
  /** Unique per provider event; makes a duplicate ledger key impossible. */
  eventId: string;
  subscriptionId: string;
  result: 'succeeded' | 'failed';
  gatewayRef: string | null;
  amountCents: number;
  currency: string;
  /** From the payment metadata: the due date for renewals, the attempt time for a first payment. */
  periodStart: string;
  attempt: number;
  occurredAt: Date;
  paymentMethodRef: string | null;
  failureCode?: string;
}

export type SettlementResult =
  /** Ledger row written and the subscription updated. */
  | 'applied'
  /** Ledger row written, subscription left alone (stale event, canceled subscription, unpaid checkout). */
  | 'recorded_only'
  /** This exact provider payment is already in the ledger. */
  | 'already_recorded'
  /** A second provider payment for an operation that was already paid. Recorded, never grants coverage. */
  | 'duplicate_charge'
  /** Not about a subscription this system knows. */
  | 'ignored';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records a payment result in the ledger and applies its effect to the
 * subscription. The decisions come from the pure domain rules; this class only
 * does the I/O. It must run inside the caller's transaction.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger('Settlement');

  async settle(tx: Prisma.TransactionClient, outcome: PaymentOutcome): Promise<SettlementResult> {
    const dueAt = new Date(outcome.periodStart);
    if (!UUID.test(outcome.subscriptionId) || Number.isNaN(dueAt.getTime())) {
      this.logger.warn(`Ignoring payment ${outcome.gatewayRef}: malformed metadata`);
      return 'ignored';
    }

    // One writer per subscription at a time: webhooks, the renewal job and
    // customer actions all serialize here.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Subscription" WHERE id = ${outcome.subscriptionId}::uuid FOR UPDATE`;
    if (locked.length === 0) {
      this.logger.warn(
        `Ignoring payment ${outcome.gatewayRef}: unknown subscription ${outcome.subscriptionId}`,
      );
      return 'ignored';
    }

    const sub = await tx.subscription.findUniqueOrThrow({
      where: { id: outcome.subscriptionId },
      include: { plan: true },
    });
    const succeeded = outcome.result === 'succeeded';
    const key = chargeIdempotencyKey(outcome.subscriptionId, outcome.periodStart, outcome.attempt);

    const existing = await tx.payment.findFirst({
      where: {
        OR: [
          ...(outcome.gatewayRef ? [{ gatewayRef: outcome.gatewayRef }] : []),
          { idempotencyKey: key },
        ],
      },
    });
    if (existing) {
      if (existing.gatewayRef === outcome.gatewayRef) return 'already_recorded';

      // Same operation, a different payment at the provider. Keep the audit
      // trail honest and change nothing else.
      await tx.payment.create({
        data: {
          subscriptionId: sub.id,
          type: succeeded ? 'charge' : 'failure',
          amountCents: outcome.amountCents,
          currency: outcome.currency,
          periodStart: null,
          attempt: outcome.attempt,
          idempotencyKey: `${key}:dup:${outcome.eventId}`,
          gatewayRef: outcome.gatewayRef,
          failureCode: outcome.failureCode ?? null,
        },
      });
      if (succeeded) {
        this.logger.error(
          `Possible double charge: ${outcome.gatewayRef} duplicates ${existing.gatewayRef} for ${key}. Refund required.`,
        );
        return 'duplicate_charge';
      }
      return 'recorded_only';
    }

    const snapshot = {
      status: sub.status,
      termCycles: sub.termCycles,
      cycleDays: sub.plan.cycleDays,
      anchorAt: sub.anchorAt,
      paidThroughAt: sub.paidThroughAt,
      failureCount: sub.failureCount,
      dueAt: sub.dueAt,
      pendingStop: sub.pendingStop,
    };
    const decision = succeeded
      ? settleSuccess(snapshot, { paidAt: outcome.occurredAt })
      : settleFailure(snapshot, { dueAt, attempt: outcome.attempt });

    const periodStart = succeeded
      ? decision.kind === 'apply'
        ? (decision.period?.start ?? outcome.occurredAt)
        : outcome.occurredAt
      : dueAt;
    await tx.payment.create({
      data: {
        subscriptionId: sub.id,
        type: succeeded ? 'charge' : 'failure',
        amountCents: outcome.amountCents,
        currency: outcome.currency,
        periodStart,
        attempt: outcome.attempt,
        idempotencyKey: key,
        gatewayRef: outcome.gatewayRef,
        failureCode: outcome.failureCode ?? null,
      },
    });

    if (decision.kind === 'record_only') {
      if (decision.reason === 'subscription_canceled') {
        this.logger.warn(
          `Payment ${outcome.gatewayRef} cleared for canceled subscription ${sub.id}. A refund may be required.`,
        );
      }
      return 'recorded_only';
    }

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        ...decision.patch,
        ...(succeeded && outcome.paymentMethodRef
          ? { paymentMethodRef: outcome.paymentMethodRef }
          : {}),
        version: { increment: 1 },
      },
    });
    return 'applied';
  }
}
