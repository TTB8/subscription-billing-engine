import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { chargeIdempotencyKey } from '@billing/domain';
import { FakeGateway, GatewayEvent } from '@billing/gateway';
import request from 'supertest';
import { Payment, Plan, Prisma, Subscription } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { Clock } from '../../src/common/clock';
import { PAYMENT_GATEWAY } from '../../src/gateway/gateway.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { setupApp } from '../../src/setup-app';

export const ADMIN_KEY = 'test-admin-key-0123456789';
export const START = new Date('2026-01-01T00:00:00.000Z');

export class TestClock extends Clock {
  current = new Date(START);

  now(): Date {
    return new Date(this.current);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  gateway: FakeGateway;
  clock: TestClock;
}

export async function createTestApp(): Promise<TestContext> {
  const clock = new TestClock();
  // The fake reads the test clock so event timestamps are controlled by the test.
  const gateway = new FakeGateway({ webhookSecret: 'whsec_e2e', now: () => clock.now() });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    gateway,
    clock,
  };
}

/** Empties every table. Refuses to run against anything that is not a *_test database. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  const name = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to truncate "${name}": e2e tests only run against *_test databases`);
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE "WebhookEvent", "Payment", "Subscription", "Customer", "PlanTerm", "Plan" CASCADE',
  );
}

export function makePlan(
  prisma: PrismaService,
  over: Partial<Prisma.PlanUncheckedCreateInput> = {},
): Promise<Plan> {
  return prisma.plan.create({
    data: {
      name: 'Standard',
      priceCents: 4900,
      currency: 'usd',
      cycleDays: 28,
      terms: {
        create: [
          { cycles: 3, discountBps: 1000, label: '12 weeks' },
          { cycles: 6, discountBps: 1500, label: '24 weeks' },
        ],
      },
      ...over,
    },
  });
}

/** Inserts a subscription directly, skipping checkout, in whatever state a test needs. */
export async function makeSubscription(
  prisma: PrismaService,
  planId: string,
  over: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
): Promise<Subscription> {
  const customer = await prisma.customer.create({
    data: { email: `c-${Math.random().toString(36).slice(2)}@example.test` },
  });
  return prisma.subscription.create({
    data: { customerId: customer.id, planId, ...over },
  });
}

/**
 * Records a successful charge the way the webhook handler will: the provider
 * really charged (so it can be refunded) and a ledger row points at it.
 */
export async function recordCharge(
  ctx: TestContext,
  subscriptionId: string,
  over: { amountCents?: number; periodStart?: Date; createdAt?: Date } = {},
): Promise<Payment> {
  const amountCents = over.amountCents ?? 4900;
  const periodStart = over.periodStart ?? START;
  const idempotencyKey = `test-charge:${subscriptionId}:${periodStart.toISOString()}`;
  const result = await ctx.gateway.chargeOffSession({
    customerRef: 'cus_test',
    paymentMethodRef: 'pm_ok',
    amountCents,
    currency: 'usd',
    description: 'test charge',
    metadata: { subscriptionId, periodStart: periodStart.toISOString(), attempt: 1 },
    idempotencyKey,
  });
  if (result.status !== 'succeeded') throw new Error('test charge was declined');
  return ctx.prisma.payment.create({
    data: {
      subscriptionId,
      type: 'charge',
      amountCents,
      currency: 'usd',
      periodStart,
      attempt: 1,
      idempotencyKey,
      gatewayRef: result.gatewayRef,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

export function recordFailure(
  prisma: PrismaService,
  subscriptionId: string,
  over: { createdAt?: Date } = {},
): Promise<Payment> {
  return prisma.payment.create({
    data: {
      subscriptionId,
      type: 'failure',
      amountCents: 4900,
      currency: 'usd',
      periodStart: START,
      attempt: 1,
      idempotencyKey: `test-failure:${subscriptionId}`,
      failureCode: 'card_declined',
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

/**
 * Makes the provider charge a card and returns the webhook event it would send.
 * `dueAt` is the due date the charge is for (the previous paid-through date).
 */
export async function chargeEvent(
  ctx: TestContext,
  o: {
    subscriptionId: string;
    dueAt: Date;
    attempt?: number;
    at?: Date;
    amountCents?: number;
    paymentMethodRef?: string;
    /** Override to simulate a second, different payment for the same operation. */
    idempotencyKey?: string;
  },
): Promise<GatewayEvent> {
  if (o.at) ctx.clock.current = new Date(o.at);
  const attempt = o.attempt ?? 1;
  ctx.gateway.takeEvents();
  await ctx.gateway.chargeOffSession({
    customerRef: 'cus_test',
    paymentMethodRef: o.paymentMethodRef ?? 'pm_ok',
    amountCents: o.amountCents ?? 4900,
    currency: 'usd',
    description: 'renewal',
    metadata: { subscriptionId: o.subscriptionId, periodStart: o.dueAt.toISOString(), attempt },
    idempotencyKey:
      o.idempotencyKey ?? chargeIdempotencyKey(o.subscriptionId, o.dueAt.toISOString(), attempt),
  });
  const [event] = ctx.gateway.takeEvents();
  if (!event) throw new Error('the fake gateway emitted no event');
  return event;
}

/** POSTs an event to the webhook endpoint, signed the way the provider signs it. */
export function deliver(ctx: TestContext, event: GatewayEvent) {
  const { payload, signature } = ctx.gateway.sign(event);
  return request(ctx.app.getHttpServer())
    .post('/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('content-type', 'application/json')
    .send(payload);
}

export const daysAfter = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);
