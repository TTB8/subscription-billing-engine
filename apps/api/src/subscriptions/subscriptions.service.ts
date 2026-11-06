import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Plan, Subscription } from '@prisma/client';
import { priceTerm, resolveStop, StopKind, termLabel, transition } from '@billing/domain';
import type { PaymentGateway } from '@billing/gateway';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/env';
import { PAYMENT_GATEWAY } from '../gateway/gateway.module';
import { PrismaService } from '../prisma/prisma.service';
import { CheckoutDto, CheckoutView, StopView, SubscriptionView } from './subscriptions.dto';

type SubscriptionWithPlan = Subscription & { plan: Plan };

function toView(sub: SubscriptionWithPlan): SubscriptionView {
  return {
    id: sub.id,
    status: sub.status,
    planId: sub.planId,
    planName: sub.plan.name,
    termCycles: sub.termCycles,
    anchorAt: sub.anchorAt,
    paidThroughAt: sub.paidThroughAt,
    pendingStop: sub.pendingStop,
    createdAt: sub.createdAt,
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Starts a subscription: prices the chosen term, creates the hosted payment
   * page and records a pending_payment subscription. The cycle does not start
   * until the payment clears (handled by the webhook).
   */
  async checkout(dto: CheckoutDto): Promise<CheckoutView> {
    const termCycles = dto.termCycles ?? 1;
    const plan = await this.prisma.plan.findFirst({
      where: { id: dto.planId, active: true },
      include: { terms: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    const discountBps =
      termCycles === 1 ? 0 : plan.terms.find((t) => t.cycles === termCycles)?.discountBps;
    if (discountBps === undefined) {
      throw new BadRequestException(`Plan "${plan.name}" has no ${termCycles}-cycle term`);
    }

    const { email } = dto;
    let customer = await this.prisma.customer.upsert({
      where: { email },
      update: {},
      create: { email },
    });

    const live = await this.prisma.subscription.findFirst({
      where: {
        customerId: customer.id,
        planId: plan.id,
        status: { in: ['active', 'past_due', 'paused'] },
      },
      select: { id: true },
    });
    if (live) throw new ConflictException('This customer already has a subscription to this plan');

    if (!customer.stripeCustomerId) {
      const { customerRef } = await this.gateway.ensureCustomer({
        email,
        idempotencyKey: `customer:${customer.id}`,
      });
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: { stripeCustomerId: customerRef },
      });
    }

    const price = priceTerm({ priceCents: plan.priceCents, cycles: termCycles, discountBps });
    const term = termLabel(termCycles, plan.cycleDays);
    const subscriptionId = randomUUID();

    // The provider call comes first: if it fails, no half-created subscription is left behind.
    const session = await this.gateway.createCheckoutSession({
      customerRef: customer.stripeCustomerId as string,
      amountCents: price.totalCents,
      currency: plan.currency,
      description: `${plan.name}, ${term}`,
      successUrl: `${this.config.appBaseUrl}/checkout/success?subscription=${subscriptionId}`,
      cancelUrl: `${this.config.appBaseUrl}/checkout/cancelled?subscription=${subscriptionId}`,
      metadata: { subscriptionId, periodStart: this.clock.now().toISOString(), attempt: 1 },
      idempotencyKey: `checkout:${subscriptionId}`,
    });

    await this.prisma.subscription.create({
      data: { id: subscriptionId, customerId: customer.id, planId: plan.id, termCycles },
    });

    return {
      subscriptionId,
      checkoutUrl: session.url,
      amountCents: price.totalCents,
      currency: plan.currency,
      term,
    };
  }

  async get(id: string): Promise<SubscriptionView> {
    return toView(await this.load(id));
  }

  /**
   * Pause or cancel. With paid time remaining it takes effect at the end of the
   * paid cycle; with nothing paid forward it takes effect now. Never refunds.
   */
  async stop(id: string, kind: StopKind): Promise<StopView> {
    const sub = await this.load(id);
    const now = this.clock.now();
    const resolution = resolveStop({
      kind,
      status: sub.status,
      now,
      paidThrough: sub.paidThroughAt,
      pendingStop: sub.pendingStop,
    });

    const data =
      resolution.effect === 'immediate'
        ? {
            status: transition(sub.status, kind === 'pause' ? 'PAUSE' : 'CANCEL'),
            pendingStop: null,
            failureCount: 0,
            dueAt: null,
            nextRetryAt: null,
          }
        : { pendingStop: kind };

    // Optimistic lock: a concurrent change makes this update match nothing.
    const updated = await this.prisma.subscription.updateMany({
      where: { id, version: sub.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new ConflictException('Subscription changed concurrently, retry');
    }

    const view = toView(await this.load(id));
    return {
      ...view,
      effectiveAt: resolution.effect === 'immediate' ? now : resolution.effectiveAt,
    };
  }

  private async load(id: string): Promise<SubscriptionWithPlan> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }
}
