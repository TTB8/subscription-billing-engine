/**
 * @file Webhook processing: verification, deduplication and application of provider events.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { GatewayEvent, PaymentGateway } from '@billing/gateway';
import { PaymentOutcome, SettlementResult, SettlementService } from '../billing/settlement.service';
import { Clock } from '../common/clock';
import { PAYMENT_GATEWAY } from '../gateway/gateway.module';
import { PrismaService } from '../prisma/prisma.service';

/** What handling one webhook did. Every value is a success to the provider. */
export type WebhookResult =
  | SettlementResult
  /** The provider event type is not one this system handles. */
  | 'ignored_type'
  /** This event id was already processed. */
  | 'duplicate_event'
  /** A payment this system did not create (no billing metadata). */
  | 'not_ours';

function toOutcome(event: GatewayEvent): PaymentOutcome | null {
  if (!event.metadata) return null;
  return {
    eventId: event.eventId,
    subscriptionId: event.metadata.subscriptionId,
    result: event.type === 'payment.succeeded' ? 'succeeded' : 'failed',
    gatewayRef: event.gatewayRef,
    amountCents: event.amountCents,
    currency: event.currency,
    periodStart: event.metadata.periodStart,
    attempt: event.metadata.attempt,
    occurredAt: event.occurredAt,
    paymentMethodRef: event.paymentMethodRef,
    ...(event.type === 'payment.failed' ? { failureCode: event.failureCode } : {}),
  };
}

/** Verifies, deduplicates and applies provider events. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Verifies, deduplicates and applies one provider event.
   *
   * The event id is stored in the same transaction as its effects. If anything
   * fails, nothing is stored, the provider retries, and the retry processes the
   * event from scratch. If the same event arrives twice, even at the same
   * moment, the second insert waits for the first and then finds it already there.
   */
  async handle(rawBody: Buffer, signature: string): Promise<WebhookResult> {
    const event = this.gateway.parseWebhook(rawBody, signature); // throws InvalidSignatureError
    if (!event) return 'ignored_type';

    return this.prisma.$transaction(async (tx) => {
      const stored = await tx.webhookEvent.createMany({
        data: [{ eventId: event.eventId, type: event.type, processedAt: this.clock.now() }],
        skipDuplicates: true,
      });
      if (stored.count === 0) return 'duplicate_event';

      const outcome = toOutcome(event);
      if (!outcome) return 'not_ours';
      return this.settlement.settle(tx, outcome);
    });
  }
}
