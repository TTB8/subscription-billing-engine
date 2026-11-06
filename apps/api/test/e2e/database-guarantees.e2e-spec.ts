import { Prisma } from '@prisma/client';
import { createTestApp, makePlan, makeSubscription, resetDb, START, TestContext } from './harness';

/**
 * The guarantees that live in the database, not in application code (see
 * docs/decisions/0006-append-only-ledger.md). Each is attacked directly, so
 * they still hold if a future code path forgets a rule.
 */
describe('Database guarantees (e2e)', () => {
  let ctx: TestContext;
  let subscriptionId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    const plan = await makePlan(ctx.prisma);
    subscriptionId = (await makeSubscription(ctx.prisma, plan.id, { status: 'active' })).id;
  });

  let counter = 0;
  const payment = (over: Partial<Prisma.PaymentUncheckedCreateInput> = {}) =>
    ctx.prisma.payment.create({
      data: {
        subscriptionId,
        type: 'charge',
        amountCents: 4900,
        currency: 'usd',
        periodStart: START,
        attempt: 1,
        idempotencyKey: `key-${(counter += 1)}`,
        gatewayRef: `pi_${counter}`,
        ...over,
      },
    });

  describe('the payment ledger', () => {
    it('allows only one successful charge per subscription period, whatever the attempt number', async () => {
      await payment();
      await expect(payment({ attempt: 2 })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('still allows several failed attempts for the same period', async () => {
      await payment({ type: 'failure', attempt: 1 });
      await payment({ type: 'failure', attempt: 2 });
      await payment({ type: 'failure', attempt: 3 });
      expect(await ctx.prisma.payment.count({ where: { type: 'failure' } })).toBe(3);
    });

    it('rejects a repeated idempotency key and a repeated provider reference', async () => {
      await payment({ idempotencyKey: 'same-key', gatewayRef: 'pi_same' });
      await expect(
        payment({ idempotencyKey: 'same-key', periodStart: new Date('2026-02-01T00:00:00Z') }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        payment({ gatewayRef: 'pi_same', periodStart: new Date('2026-03-01T00:00:00Z') }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it.each([
      ['a negative amount', { amountCents: -1 }, 'Payment_amountCents_nonneg'],
      ['an attempt number below 1', { attempt: 0 }, 'Payment_attempt_positive'],
    ])('rejects %s', async (_name, over, constraint) => {
      await expect(payment(over)).rejects.toThrow(constraint);
    });

    it('requires a refund to reference a charge, and nothing else to', async () => {
      const charge = await payment();
      await expect(payment({ type: 'refund', periodStart: null })).rejects.toThrow(
        'Payment_refund_links_charge',
      );
      await expect(payment({ type: 'failure', attempt: 2, refundOfId: charge.id })).rejects.toThrow(
        'Payment_refund_links_charge',
      );
      await expect(
        payment({ type: 'refund', periodStart: null, refundOfId: charge.id }),
      ).resolves.toMatchObject({
        type: 'refund',
      });
    });

    it('rejects every update and delete', async () => {
      const row = await payment();
      await expect(
        ctx.prisma.payment.update({ where: { id: row.id }, data: { amountCents: 1 } }),
      ).rejects.toThrow('append-only');
      await expect(ctx.prisma.payment.delete({ where: { id: row.id } })).rejects.toThrow(
        'append-only',
      );
      await expect(ctx.prisma.payment.deleteMany()).rejects.toThrow('append-only');
    });
  });

  describe('plans and subscriptions', () => {
    it.each([
      [
        'a negative plan price',
        () => makePlan(ctx.prisma, { name: 'Bad price', priceCents: -1 }),
        'Plan_priceCents_nonneg',
      ],
      [
        'a zero-day cycle',
        () => makePlan(ctx.prisma, { name: 'Bad cycle', cycleDays: 0 }),
        'Plan_cycleDays_positive',
      ],
    ])('rejects %s', async (_name, create, constraint) => {
      await expect(create()).rejects.toThrow(constraint);
    });

    it.each([
      ['a discount above 100%', { discountBps: 10_001 }, 'PlanTerm_discountBps_range'],
      ['a negative discount', { discountBps: -1 }, 'PlanTerm_discountBps_range'],
      ['a term of zero cycles', { cycles: 0 }, 'PlanTerm_cycles_positive'],
    ])('rejects %s on a term', async (_name, over, constraint) => {
      const plan = await makePlan(ctx.prisma, { name: 'Terms', terms: { create: [] } });
      await expect(
        ctx.prisma.planTerm.create({
          data: { planId: plan.id, cycles: 3, discountBps: 0, label: 'x', ...over },
        }),
      ).rejects.toThrow(constraint);
    });

    it('rejects two terms of the same length on one plan', async () => {
      const plan = await makePlan(ctx.prisma, { name: 'Dupes', terms: { create: [] } });
      const term = { planId: plan.id, cycles: 3, discountBps: 0, label: '12 weeks' };
      await ctx.prisma.planTerm.create({ data: term });
      await expect(ctx.prisma.planTerm.create({ data: term })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it.each([
      ['a term of zero cycles', { termCycles: 0 }, 'Subscription_termCycles_positive'],
      ['a negative failure count', { failureCount: -1 }, 'Subscription_failureCount_nonneg'],
    ])('rejects %s on a subscription', async (_name, over, constraint) => {
      await expect(
        ctx.prisma.subscription.update({ where: { id: subscriptionId }, data: over }),
      ).rejects.toThrow(constraint);
    });
  });
});
