import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Payment } from '@prisma/client';
import { refundIdempotencyKey, resolveRefund, summarizeLedger } from '@billing/domain';
import { GatewayError, PaymentGateway } from '@billing/gateway';
import { PAYMENT_GATEWAY } from '../gateway/gateway.module';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerEntryView, LedgerView, RefundDto, RefundView } from './payments.dto';

function toEntry(p: Payment): LedgerEntryView {
  return {
    id: p.id,
    type: p.type,
    amountCents: p.amountCents,
    currency: p.currency,
    periodStart: p.periodStart,
    attempt: p.attempt,
    gatewayRef: p.gatewayRef,
    failureCode: p.failureCode,
    refundOfId: p.refundOfId,
    createdAt: p.createdAt,
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Refunds a charge, fully or partially, and records it in the ledger.
   *
   * The charge row is locked for the whole operation, so two concurrent refunds
   * of the same charge run one after the other and the second sees the first.
   * The provider idempotency key is `refund:<charge>:<n>` where n is this
   * refund's position for the charge. If the provider call succeeds but the
   * response or the ledger write is lost, retrying recomputes the same key and
   * the provider replays the original refund instead of repeating it.
   */
  async refund(chargeId: string, dto: RefundDto): Promise<RefundView> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Payment" WHERE id = ${chargeId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('Payment not found');

        const charge = await tx.payment.findUniqueOrThrow({ where: { id: chargeId } });
        if (charge.type !== 'charge' || !charge.gatewayRef) {
          throw new ConflictException('Only successful charges can be refunded');
        }

        const earlier = await tx.payment.findMany({
          where: { refundOfId: charge.id },
          select: { amountCents: true },
        });
        const refundedBefore = earlier.reduce((sum, r) => sum + r.amountCents, 0);
        const amountCents = resolveRefund({
          chargedCents: charge.amountCents,
          refundedCents: refundedBefore,
          requestedCents: dto.amountCents,
        });

        const idempotencyKey = refundIdempotencyKey(charge.id, earlier.length + 1);
        const result = await this.gateway.refund({
          gatewayRef: charge.gatewayRef,
          amountCents,
          idempotencyKey,
        });
        if (result.status === 'failed') {
          throw new GatewayError(`Provider rejected refund ${result.refundRef}`);
        }

        const row = await tx.payment.create({
          data: {
            subscriptionId: charge.subscriptionId,
            type: 'refund',
            amountCents,
            currency: charge.currency,
            idempotencyKey,
            gatewayRef: result.refundRef,
            refundOfId: charge.id,
          },
        });

        const refundedCents = refundedBefore + amountCents;
        return {
          refundId: row.id,
          chargeId: charge.id,
          amountCents,
          currency: charge.currency,
          refundedCents,
          remainingCents: charge.amountCents - refundedCents,
          status: result.status,
        };
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
  }

  async ledger(subscriptionId: string): Promise<LedgerView> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');

    const rows = await this.prisma.payment.findMany({
      where: { subscriptionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { subscriptionId, ...summarizeLedger(rows), entries: rows.map(toEntry) };
  }
}
