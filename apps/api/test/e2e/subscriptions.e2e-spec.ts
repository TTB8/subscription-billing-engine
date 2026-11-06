import request from 'supertest';
import { createTestApp, makePlan, makeSubscription, resetDb, START, TestContext } from './harness';

describe('Subscriptions (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const checkout = (body: object) => http().post('/subscriptions/checkout').send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.clock.current = new Date(START);
    ctx.gateway.setOutage(false);
  });

  describe('POST /subscriptions/checkout', () => {
    it('prices one cycle, saves the customer and leaves the subscription unpaid', async () => {
      const plan = await makePlan(ctx.prisma);
      const { body } = await checkout({ email: 'ana@example.test', planId: plan.id }).expect(201);

      expect(body).toMatchObject({ amountCents: 4900, currency: 'usd', term: '4 weeks' });
      expect(body.checkoutUrl).toContain('https://fake.invalid/pay/');

      const sub = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: body.subscriptionId },
        include: { customer: true },
      });
      expect(sub).toMatchObject({
        status: 'pending_payment',
        termCycles: 1,
        anchorAt: null,
        paidThroughAt: null,
        pendingStop: null,
      });
      expect(sub.customer.stripeCustomerId).toMatch(/^cus_fake_/);
    });

    it('charges the discounted total for a prepaid term', async () => {
      const plan = await makePlan(ctx.prisma);
      const { body } = await checkout({
        email: 'ana@example.test',
        planId: plan.id,
        termCycles: 3,
      }).expect(201);
      expect(body).toMatchObject({ amountCents: 13_230, term: '12 weeks' });
      expect(
        (await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: body.subscriptionId } }))
          .termCycles,
      ).toBe(3);
    });

    it('sends the right amount and metadata to the payment page', async () => {
      const plan = await makePlan(ctx.prisma);
      const { body } = await checkout({
        email: 'ana@example.test',
        planId: plan.id,
        termCycles: 6,
      }).expect(201);

      const sessionRef = body.checkoutUrl.split('/').pop() as string;
      ctx.gateway.completeCheckout(sessionRef, 'pm_ok');
      expect(ctx.gateway.takeEvents()[0]).toMatchObject({
        type: 'payment.succeeded',
        amountCents: 24_990,
        metadata: {
          subscriptionId: body.subscriptionId,
          attempt: 1,
          periodStart: START.toISOString(),
        },
      });
    });

    it('normalizes the email and reuses the customer', async () => {
      const plan = await makePlan(ctx.prisma);
      await checkout({ email: '  Ana@Example.TEST ', planId: plan.id }).expect(201);
      await checkout({ email: 'ana@example.test', planId: plan.id }).expect(201);
      expect(await ctx.prisma.customer.count()).toBe(1);
      expect(await ctx.prisma.subscription.count()).toBe(2);
    });

    it('allows a new subscription after the previous one was canceled or never paid', async () => {
      const plan = await makePlan(ctx.prisma);
      const first = await checkout({ email: 'ana@example.test', planId: plan.id }).expect(201);
      await ctx.prisma.subscription.update({
        where: { id: first.body.subscriptionId },
        data: { status: 'canceled' },
      });
      await checkout({ email: 'ana@example.test', planId: plan.id }).expect(201);
    });

    it.each(['active', 'past_due', 'paused'] as const)(
      'returns 409 when the customer already has a %s subscription to the plan',
      async (status) => {
        const plan = await makePlan(ctx.prisma);
        const live = await ctx.prisma.customer.create({ data: { email: 'ana@example.test' } });
        await ctx.prisma.subscription.create({
          data: { customerId: live.id, planId: plan.id, status },
        });
        await checkout({ email: 'ana@example.test', planId: plan.id }).expect(409);
      },
    );

    it('allows the same customer to subscribe to a different plan', async () => {
      const standard = await makePlan(ctx.prisma);
      const other = await makePlan(ctx.prisma, { name: 'Premium', priceCents: 9900 });
      const customer = await ctx.prisma.customer.create({ data: { email: 'ana@example.test' } });
      await ctx.prisma.subscription.create({
        data: { customerId: customer.id, planId: standard.id, status: 'active' },
      });
      await checkout({ email: 'ana@example.test', planId: other.id }).expect(201);
    });

    it('returns 404 for an unknown or inactive plan', async () => {
      await checkout({
        email: 'ana@example.test',
        planId: '00000000-0000-4000-8000-000000000000',
      }).expect(404);
      const retired = await makePlan(ctx.prisma, { name: 'Retired', active: false });
      await checkout({ email: 'ana@example.test', planId: retired.id }).expect(404);
    });

    it('returns 400 for a term the plan does not offer', async () => {
      const plan = await makePlan(ctx.prisma);
      await checkout({ email: 'ana@example.test', planId: plan.id, termCycles: 4 }).expect(400);
      expect(await ctx.prisma.subscription.count()).toBe(0);
    });

    it.each([
      ['an invalid email', { email: 'nope' }],
      ['a non-uuid plan id', { planId: '123' }],
      ['zero cycles', { termCycles: 0 }],
      ['fractional cycles', { termCycles: 1.5 }],
      ['an unknown field', { amountCents: 1 }],
    ])('returns 400 for %s', async (_name, override) => {
      const plan = await makePlan(ctx.prisma);
      await checkout({ email: 'ana@example.test', planId: plan.id, ...override }).expect(400);
    });

    it('returns 503 and creates no subscription when the payment provider is down', async () => {
      const plan = await makePlan(ctx.prisma);
      ctx.gateway.setOutage(true);
      const { body } = await checkout({ email: 'ana@example.test', planId: plan.id }).expect(503);
      expect(body.message).toContain('unavailable');
      expect(await ctx.prisma.subscription.count()).toBe(0);
    });
  });

  describe('GET /subscriptions/:id', () => {
    it('returns the subscription', async () => {
      const plan = await makePlan(ctx.prisma);
      const sub = await makeSubscription(ctx.prisma, plan.id, { status: 'active' });
      const { body } = await http().get(`/subscriptions/${sub.id}`).expect(200);
      expect(body).toMatchObject({
        id: sub.id,
        status: 'active',
        planName: 'Standard',
        pendingStop: null,
      });
    });

    it('returns 404 for an unknown id and 400 for a malformed one', async () => {
      await http().get('/subscriptions/00000000-0000-4000-8000-000000000000').expect(404);
      await http().get('/subscriptions/not-a-uuid').expect(400);
    });
  });

  describe('pause and cancel', () => {
    const daysFromStart = (days: number) => new Date(START.getTime() + days * 86_400_000);

    let planCount = 0;
    const activeSub = async (over = {}) => {
      const plan = await makePlan(ctx.prisma, { name: `Standard ${(planCount += 1)}` });
      return makeSubscription(ctx.prisma, plan.id, {
        status: 'active',
        anchorAt: daysFromStart(-18),
        paidThroughAt: daysFromStart(10),
        ...over,
      });
    };

    it.each(['cancel', 'pause'] as const)(
      '%s waits for the end of the paid cycle and refunds nothing',
      async (kind) => {
        const sub = await activeSub();
        const { body } = await http().post(`/subscriptions/${sub.id}/${kind}`).expect(200);

        expect(body).toMatchObject({ status: 'active', pendingStop: kind });
        expect(body.effectiveAt).toBe(daysFromStart(10).toISOString());
        expect(await ctx.prisma.payment.count()).toBe(0);
      },
    );

    it('takes effect immediately when nothing is paid forward', async () => {
      const sub = await activeSub({ paidThroughAt: daysFromStart(-1) });
      const { body } = await http().post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(body).toMatchObject({ status: 'canceled', pendingStop: null });
      expect(body.effectiveAt).toBe(START.toISOString());
    });

    it('pauses a past_due subscription at once and clears its dunning state', async () => {
      const sub = await activeSub({
        status: 'past_due',
        paidThroughAt: daysFromStart(-3),
        failureCount: 2,
        dueAt: daysFromStart(-3),
        nextRetryAt: daysFromStart(1),
      });
      const { body } = await http().post(`/subscriptions/${sub.id}/pause`).expect(200);
      expect(body.status).toBe('paused');

      const stored = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(stored).toMatchObject({
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
        pendingStop: null,
      });
    });

    it('cancels an unpaid pending_payment subscription immediately but cannot pause it', async () => {
      const plan = await makePlan(ctx.prisma);
      const sub = await makeSubscription(ctx.prisma, plan.id);
      await http().post(`/subscriptions/${sub.id}/pause`).expect(409);
      const { body } = await http().post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(body.status).toBe('canceled');
    });

    it('lets cancel replace a scheduled pause, but not the other way round', async () => {
      const sub = await activeSub();
      await http().post(`/subscriptions/${sub.id}/pause`).expect(200);
      const cancelled = await http().post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(cancelled.body.pendingStop).toBe('cancel');
      await http().post(`/subscriptions/${sub.id}/pause`).expect(409);
    });

    it('is idempotent when the same request is repeated', async () => {
      const sub = await activeSub();
      const first = await http().post(`/subscriptions/${sub.id}/cancel`).expect(200);
      const second = await http().post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(second.body).toEqual(first.body);
    });

    it('returns 409 for an already canceled or paused subscription', async () => {
      const done = await activeSub({ status: 'canceled' });
      await http().post(`/subscriptions/${done.id}/cancel`).expect(409);
      await http().post(`/subscriptions/${done.id}/pause`).expect(409);
      const paused = await activeSub({ status: 'paused' });
      await http().post(`/subscriptions/${paused.id}/pause`).expect(409);
    });

    it('returns 404 and 400 for unknown and malformed ids', async () => {
      await http().post('/subscriptions/00000000-0000-4000-8000-000000000000/cancel').expect(404);
      await http().post('/subscriptions/not-a-uuid/pause').expect(400);
    });

    it('never lets two concurrent requests both overwrite a subscription', async () => {
      const sub = await activeSub();
      const results = await Promise.all([
        http().post(`/subscriptions/${sub.id}/cancel`),
        http().post(`/subscriptions/${sub.id}/pause`),
      ]);
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
      expect(statuses).toContain(200);

      const stored = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(['cancel', 'pause']).toContain(stored.pendingStop);
      expect(stored.version).toBeGreaterThan(0);
    });
  });
});
