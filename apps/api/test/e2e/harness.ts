import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FakeGateway } from '@billing/gateway';
import { Plan, Prisma, Subscription } from '@prisma/client';
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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    gateway: app.get<FakeGateway>(PAYMENT_GATEWAY),
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
