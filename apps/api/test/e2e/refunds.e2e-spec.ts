import request from 'supertest';
import {
  ADMIN_KEY,
  createTestApp,
  makePlan,
  makeSubscription,
  recordCharge,
  recordFailure,
  resetDb,
  TestContext,
} from './harness';

describe('Refunds and ledger (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const refund = (paymentId: string, body: object = {}) =>
    http().post(`/admin/payments/${paymentId}/refund`).set('x-admin-key', ADMIN_KEY).send(body);
  const ledger = (subscriptionId: string) =>
    http().get(`/admin/subscriptions/${subscriptionId}/ledger`).set('x-admin-key', ADMIN_KEY);

  let subscriptionId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.gateway.reset();
    const plan = await makePlan(ctx.prisma);
    subscriptionId = (await makeSubscription(ctx.prisma, plan.id, { status: 'active' })).id;
  });

  const refundRows = () => ctx.prisma.payment.findMany({ where: { type: 'refund' } });

  describe('POST /admin/payments/:id/refund', () => {
    it('requires the admin key', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      await http().post(`/admin/payments/${charge.id}/refund`).send({}).expect(401);
      expect(await refundRows()).toHaveLength(0);
    });

    it('refunds the whole charge by default and records it in the ledger', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      const { body } = await refund(charge.id).expect(201);

      expect(body).toMatchObject({
        chargeId: charge.id,
        amountCents: 4900,
        currency: 'usd',
        refundedCents: 4900,
        remainingCents: 0,
        status: 'succeeded',
      });
      const [row] = await refundRows();
      expect(row).toMatchObject({
        id: body.refundId,
        subscriptionId,
        amountCents: 4900,
        refundOfId: charge.id,
        idempotencyKey: `refund:${charge.id}:1`,
      });
      expect(row?.gatewayRef).toMatch(/^re_fake_/);
      expect(ctx.gateway.refunds).toHaveLength(1);
    });

    it('refunds partially, then the rest, and then refuses more', async () => {
      const charge = await recordCharge(ctx, subscriptionId);

      const first = await refund(charge.id, { amountCents: 1000 }).expect(201);
      expect(first.body).toMatchObject({ refundedCents: 1000, remainingCents: 3900 });

      const rest = await refund(charge.id).expect(201);
      expect(rest.body).toMatchObject({
        amountCents: 3900,
        refundedCents: 4900,
        remainingCents: 0,
      });

      await refund(charge.id).expect(409);
      await refund(charge.id, { amountCents: 1 }).expect(409);
      expect(await refundRows()).toHaveLength(2);
      expect(ctx.gateway.refunds.map((r) => r.amountCents)).toEqual([1000, 3900]);
    });

    it('refuses to refund more than remains and says how much does', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      await refund(charge.id, { amountCents: 4000 }).expect(201);
      const { body } = await refund(charge.id, { amountCents: 901 }).expect(409);
      expect(body.message).toContain('only 900 remains');
      expect(await refundRows()).toHaveLength(1);
    });

    it.each([
      ['zero', { amountCents: 0 }],
      ['negative', { amountCents: -5 }],
      ['fractional', { amountCents: 10.5 }],
      ['an unknown field', { surprise: true }],
    ])('rejects an amount that is %s', async (_name, body) => {
      const charge = await recordCharge(ctx, subscriptionId);
      await refund(charge.id, body).expect(400);
      expect(await refundRows()).toHaveLength(0);
    });

    it('returns 404 for an unknown payment and 400 for a malformed id', async () => {
      await refund('00000000-0000-4000-8000-000000000000').expect(404);
      await refund('not-a-uuid').expect(400);
    });

    it('only refunds successful charges, not failures or other refunds', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      const failure = await recordFailure(ctx.prisma, subscriptionId);
      await refund(failure.id).expect(409);

      const { body } = await refund(charge.id, { amountCents: 100 }).expect(201);
      await refund(body.refundId).expect(409);
      expect(await refundRows()).toHaveLength(1);
    });

    it('does not touch the subscription: refunding never cancels or shortens coverage', async () => {
      await ctx.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { paidThroughAt: new Date('2026-02-01T00:00:00.000Z') },
      });
      const charge = await recordCharge(ctx, subscriptionId);
      await refund(charge.id).expect(201);

      const sub = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });
      expect(sub).toMatchObject({
        status: 'active',
        paidThroughAt: new Date('2026-02-01T00:00:00.000Z'),
      });
    });

    it('lets only one of two simultaneous full refunds through', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      const results = await Promise.all([refund(charge.id), refund(charge.id)]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await refundRows()).toHaveLength(1);
      expect(ctx.gateway.refunds).toHaveLength(1);
    });

    it('lets simultaneous partial refunds through only while they fit', async () => {
      const charge = await recordCharge(ctx, subscriptionId, { amountCents: 1000 });
      const results = await Promise.all(
        [400, 400, 400].map((amountCents) => refund(charge.id, { amountCents })),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
      const total = (await refundRows()).reduce((sum, r) => sum + r.amountCents, 0);
      expect(total).toBe(800);
      expect(total).toBeLessThanOrEqual(1000);
    });

    it('returns 503 and records nothing when the provider is unreachable, then succeeds on retry', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      ctx.gateway.setOutage(true);
      await refund(charge.id).expect(503);
      expect(await refundRows()).toHaveLength(0);

      ctx.gateway.setOutage(false);
      await refund(charge.id).expect(201);
      expect(await refundRows()).toHaveLength(1);
      expect(ctx.gateway.refunds).toHaveLength(1);
    });

    it('never refunds twice when the provider response is lost and the admin retries', async () => {
      const charge = await recordCharge(ctx, subscriptionId);
      ctx.gateway.loseNextResponse();

      await refund(charge.id).expect(503);
      expect(ctx.gateway.refunds).toHaveLength(1); // the provider did refund
      expect(await refundRows()).toHaveLength(0); // but the ledger has not caught up

      const { body } = await refund(charge.id).expect(201);
      expect(body).toMatchObject({ amountCents: 4900, remainingCents: 0 });
      expect(ctx.gateway.refunds).toHaveLength(1); // the retry replayed, it did not refund again
      expect(await refundRows()).toHaveLength(1);
    });
  });

  describe('GET /admin/subscriptions/:id/ledger', () => {
    it('requires the admin key', async () => {
      await http().get(`/admin/subscriptions/${subscriptionId}/ledger`).expect(401);
    });

    it('is empty and zero for a subscription with no payments', async () => {
      const { body } = await ledger(subscriptionId).expect(200);
      expect(body).toEqual({
        subscriptionId,
        chargedCents: 0,
        refundedCents: 0,
        netCents: 0,
        entries: [],
      });
    });

    it('lists charges, failures and refunds in order and totals only money that moved', async () => {
      const charge = await recordCharge(ctx, subscriptionId, {
        createdAt: new Date('2026-01-01T10:00:00Z'),
      });
      await recordFailure(ctx.prisma, subscriptionId, {
        createdAt: new Date('2026-01-02T10:00:00Z'),
      });
      await refund(charge.id, { amountCents: 1000 }).expect(201);

      const { body } = await ledger(subscriptionId).expect(200);

      expect(body).toMatchObject({ chargedCents: 4900, refundedCents: 1000, netCents: 3900 });
      expect(body.entries.map((e: { type: string }) => e.type)).toEqual([
        'charge',
        'failure',
        'refund',
      ]);
      expect(body.entries[1]).toMatchObject({ failureCode: 'card_declined', amountCents: 4900 });
      expect(body.entries[2]).toMatchObject({ refundOfId: charge.id, amountCents: 1000 });
    });

    it('returns 404 for an unknown subscription and 400 for a malformed id', async () => {
      await ledger('00000000-0000-4000-8000-000000000000').expect(404);
      await ledger('nope').expect(400);
    });
  });

  it('cannot rewrite history: the database rejects edits to a ledger row', async () => {
    const charge = await recordCharge(ctx, subscriptionId);
    await expect(
      ctx.prisma.payment.update({ where: { id: charge.id }, data: { amountCents: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.payment.delete({ where: { id: charge.id } })).rejects.toThrow(
      /append-only/,
    );
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: charge.id } })).amountCents,
    ).toBe(4900);
  });
});
