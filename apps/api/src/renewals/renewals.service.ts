/**
 * @file The renewal and dunning-retry job: finds subscriptions that are due and charges them
 * off-session, recording results through the shared settlement.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  chargeIdempotencyKey,
  decideRenewal,
  isRetryDue,
  priceTerm,
  termLabel,
  transition,
} from '@billing/domain';
import { GatewayUnavailableError, PaymentGateway } from '@billing/gateway';
import { PaymentOutcome, SettlementService } from '../billing/settlement.service';
import { Clock } from '../common/clock';
import { PAYMENT_GATEWAY } from '../gateway/gateway.module';
import { PrismaService } from '../prisma/prisma.service';

/** Subscriptions looked at per run. Anything beyond this waits for the next run. */
const BATCH_SIZE = 200;

/** What one run of the renewal job did, counted per outcome. */
export interface RenewalSummary {
  /** Subscriptions that looked due when the run started. */
  examined: number;
  charged: number;
  /** Charges the provider declined. These enter or continue dunning. */
  failed: number;
  /** Scheduled pauses and cancellations applied instead of a charge. */
  paused: number;
  canceled: number;
  /** No longer due by the time the row was locked (paid by a webhook, stopped, retried by another run). */
  skipped: number;
  /** The provider did not answer. Nothing was recorded; the next run repeats the same charge safely. */
  unknownOutcome: number;
  /** Needs a human: the plan can no longer price the term, or the provider rejected the request outright. */
  errors: number;
}

interface Charge {
  subscriptionId: string;
  dueAt: Date;
  attempt: number;
  amountCents: number;
  currency: string;
  description: string;
  key: string;
  customerRef: string | null;
  paymentMethodRef: string | null;
}

type Prepared =
  | { kind: 'skip' }
  | { kind: 'stopped'; stop: 'paused' | 'canceled' }
  | { kind: 'unpriceable'; subscriptionId: string }
  | { kind: 'charge'; charge: Charge };

/**
 * Charges subscriptions that are due, and retries failed ones.
 *
 * Every charge is identified by (subscription, due date, attempt). The job
 * derives that from stored state each time, so running it twice, running it on
 * two servers at once, or repeating a charge whose response was lost all send
 * the provider the same idempotency key and get the same payment back.
 *
 * Locks are held only to decide and to record, never across the provider call,
 * so a slow provider cannot block webhooks or customer actions.
 */
@Injectable()
export class RenewalsService {
  private readonly logger = new Logger('Renewals');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async runDue(): Promise<RenewalSummary> {
    const now = this.clock.now();
    const [due, retries] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { status: 'active', paidThroughAt: { lte: now } },
        orderBy: { paidThroughAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      }),
      this.prisma.subscription.findMany({
        where: { status: 'past_due', nextRetryAt: { lte: now } },
        orderBy: { nextRetryAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      }),
    ]);
    const ids = [...new Set([...due, ...retries].map((s) => s.id))];

    const summary: RenewalSummary = {
      examined: ids.length,
      charged: 0,
      failed: 0,
      paused: 0,
      canceled: 0,
      skipped: 0,
      unknownOutcome: 0,
      errors: 0,
    };

    // One at a time, and one subscription's problem never stops the rest.
    for (const id of ids) {
      try {
        await this.renew(id, now, summary);
      } catch (error) {
        summary.errors += 1;
        this.logger.error(`Renewal of ${id} needs attention: ${(error as Error).message}`);
      }
    }
    return summary;
  }

  private async renew(id: string, now: Date, summary: RenewalSummary): Promise<void> {
    const prepared = await this.prisma.$transaction((tx) => this.prepare(tx, id, now));

    switch (prepared.kind) {
      case 'skip':
        summary.skipped += 1;
        return;
      case 'stopped':
        summary[prepared.stop === 'paused' ? 'paused' : 'canceled'] += 1;
        return;
      case 'unpriceable':
        summary.errors += 1;
        this.logger.error(
          `Subscription ${prepared.subscriptionId}: its plan can no longer price the chosen term`,
        );
        return;
      case 'charge':
        break;
    }

    const { charge } = prepared;
    const outcome = await this.attemptCharge(charge);
    if (outcome === 'unknown') {
      summary.unknownOutcome += 1;
      return;
    }

    await this.prisma.$transaction((tx) => this.settlement.settle(tx, outcome));
    summary[outcome.result === 'succeeded' ? 'charged' : 'failed'] += 1;
  }

  /** Decides what is owed, under the subscription lock. Applies scheduled pauses and cancellations. */
  private async prepare(tx: Prisma.TransactionClient, id: string, now: Date): Promise<Prepared> {
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${id}::uuid FOR UPDATE`;
    const sub = await tx.subscription.findUnique({
      where: { id },
      include: { plan: { include: { terms: true } }, customer: true },
    });
    if (!sub) return { kind: 'skip' };

    let dueAt: Date;
    let attempt: number;

    if (sub.status === 'active') {
      const decision = decideRenewal({
        status: sub.status,
        paidThrough: sub.paidThroughAt,
        now,
        pendingStop: sub.pendingStop,
      });
      if (decision === 'not_due') return { kind: 'skip' };
      if (decision === 'pause' || decision === 'cancel') {
        await tx.subscription.update({
          where: { id },
          data: {
            status: transition(sub.status, decision === 'pause' ? 'PAUSE' : 'CANCEL'),
            pendingStop: null,
            failureCount: 0,
            dueAt: null,
            nextRetryAt: null,
            version: { increment: 1 },
          },
        });
        return { kind: 'stopped', stop: decision === 'pause' ? 'paused' : 'canceled' };
      }
      dueAt = sub.paidThroughAt as Date; // decideRenewal returned 'charge', so it is set
      attempt = 1;
    } else if (sub.status === 'past_due') {
      if (!sub.dueAt || !sub.nextRetryAt || !isRetryDue(sub.nextRetryAt, now)) {
        return { kind: 'skip' };
      }
      dueAt = sub.dueAt;
      attempt = sub.failureCount + 1;
    } else {
      return { kind: 'skip' };
    }

    const discountBps =
      sub.termCycles === 1
        ? 0
        : sub.plan.terms.find((t) => t.cycles === sub.termCycles)?.discountBps;
    if (discountBps === undefined) return { kind: 'unpriceable', subscriptionId: id };

    const price = priceTerm({
      priceCents: sub.plan.priceCents,
      cycles: sub.termCycles,
      discountBps,
    });
    return {
      kind: 'charge',
      charge: {
        subscriptionId: id,
        dueAt,
        attempt,
        amountCents: price.totalCents,
        currency: sub.plan.currency,
        description: `${sub.plan.name}, ${termLabel(sub.termCycles, sub.plan.cycleDays)}`,
        key: chargeIdempotencyKey(id, dueAt.toISOString(), attempt),
        customerRef: sub.customer.stripeCustomerId,
        paymentMethodRef: sub.paymentMethodRef,
      },
    };
  }

  /** Calls the provider outside any lock. 'unknown' means no answer: record nothing and repeat next run. */
  private async attemptCharge(charge: Charge): Promise<PaymentOutcome | 'unknown'> {
    const base = {
      eventId: `renewal:${charge.key}`,
      subscriptionId: charge.subscriptionId,
      amountCents: charge.amountCents,
      currency: charge.currency,
      periodStart: charge.dueAt.toISOString(),
      attempt: charge.attempt,
      occurredAt: this.clock.now(),
      paymentMethodRef: charge.paymentMethodRef,
    };

    if (!charge.customerRef || !charge.paymentMethodRef) {
      return { ...base, result: 'failed', gatewayRef: null, failureCode: 'no_payment_method' };
    }

    try {
      const result = await this.gateway.chargeOffSession({
        customerRef: charge.customerRef,
        paymentMethodRef: charge.paymentMethodRef,
        amountCents: charge.amountCents,
        currency: charge.currency,
        description: charge.description,
        metadata: {
          subscriptionId: charge.subscriptionId,
          periodStart: charge.dueAt.toISOString(),
          attempt: charge.attempt,
        },
        idempotencyKey: charge.key,
      });
      return result.status === 'succeeded'
        ? { ...base, result: 'succeeded', gatewayRef: result.gatewayRef }
        : {
            ...base,
            result: 'failed',
            gatewayRef: result.gatewayRef,
            failureCode: result.failureCode,
          };
    } catch (error) {
      if (error instanceof GatewayUnavailableError) {
        this.logger.warn(`No answer charging ${charge.key}; it will be repeated with the same key`);
        return 'unknown';
      }
      throw error; // a rejected request is a bug or a configuration problem, not a declined card
    }
  }
}
