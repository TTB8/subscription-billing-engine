import request from 'supertest';
import { GatewayEvent } from '@billing/gateway';
import { Subscription } from '@prisma/client';
import { SettlementService } from '../../src/billing/settlement.service';
import {
  chargeEvent,
  createTestApp,
  daysAfter,
  deliver,
  makePlan,
  makeSubscription,
  resetDb,
  START,
  TestContext,
} from './harness';

describe('Stripe webhooks (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.gateway.reset();
    ctx.clock.current = new Date(START);
  });

  const D = START; // the renewal due date used by the renewal scenarios

  /** An active subscription whose paid cycle ends at D, as if renewal were due now. */
  async function dueSubscription(over: Partial<Subscription> = {}): Promise<Subscription> {
    const plan = await makePlan(ctx.prisma);
    return makeSubscription(ctx.prisma, plan.id, {
      status: 'active',
      anchorAt: daysAfter(D, -28),
      paidThroughAt: D,
      ...over,
    });
  }

  const reload = (id: string) => ctx.prisma.subscription.findUniqueOrThrow({ where: { id } });
  const payments = (subscriptionId: string) =>
    ctx.prisma.payment.findMany({
      where: { subscriptionId },
      orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }],
    });
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  describe('signature verification', () => {
    const signedEvent = async () => {
      const sub = await dueSubscription();
      return { sub, event: await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D }) };
    };

    it('rejects a request with no signature header', async () => {
      const { event } = await signedEvent();
      const { payload } = ctx.gateway.sign(event);
      await http()
        .post('/webhooks/stripe')
        .set('content-type', 'application/json')
        .send(payload)
        .expect(400);
    });

    it('rejects a wrong signature and a tampered body, and changes nothing', async () => {
      const { sub, event } = await signedEvent();
      const { payload, signature } = ctx.gateway.sign(event);

      await http()
        .post('/webhooks/stripe')
        .set('stripe-signature', 'deadbeef')
        .set('content-type', 'application/json')
        .send(payload)
        .expect(400);
      await http()
        .post('/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('content-type', 'application/json')
        .send(payload.replace('4900', '1'))
        .expect(400);

      expect(await ctx.prisma.webhookEvent.count()).toBe(0);
      expect(await payments(sub.id)).toHaveLength(0);
    });
  });

  describe('first payment (checkout)', () => {
    async function checkout(termCycles?: number) {
      const plan = await makePlan(ctx.prisma);
      const { body } = await http()
        .post('/subscriptions/checkout')
        .send({ email: 'ana@example.test', planId: plan.id, ...(termCycles ? { termCycles } : {}) })
        .expect(201);
      return {
        subscriptionId: body.subscriptionId as string,
        sessionRef: body.checkoutUrl.split('/').pop() as string,
      };
    }

    it('activates the subscription and anchors the cycle to the moment the payment cleared', async () => {
      const { subscriptionId, sessionRef } = await checkout();
      ctx.clock.current = new Date('2026-01-04T13:45:00.000Z');
      ctx.gateway.completeCheckout(sessionRef, 'pm_ok');

      const [event] = ctx.gateway.takeEvents();
      const response = await deliver(ctx, event!).expect(200);
      expect(response.body).toEqual({ received: true, result: 'applied' });

      const sub = await reload(subscriptionId);
      expect(sub).toMatchObject({ status: 'active', paymentMethodRef: 'pm_ok', failureCount: 0 });
      expect(iso(sub.anchorAt)).toBe('2026-01-04T13:45:00.000Z');
      expect(iso(sub.paidThroughAt)).toBe('2026-02-01T13:45:00.000Z'); // 28 days, not "next month"

      const [charge] = await payments(subscriptionId);
      expect(charge).toMatchObject({ type: 'charge', amountCents: 4900, attempt: 1 });
      expect(iso(charge!.periodStart)).toBe('2026-01-04T13:45:00.000Z');
      expect(charge!.gatewayRef).toMatch(/^pi_fake_/);

      const stored = await ctx.prisma.webhookEvent.findUniqueOrThrow({
        where: { eventId: event!.eventId },
      });
      expect(stored.processedAt).not.toBeNull();
    });

    it('covers a whole prepaid term and records the discounted amount', async () => {
      const { subscriptionId, sessionRef } = await checkout(3);
      ctx.gateway.completeCheckout(sessionRef, 'pm_ok');
      await deliver(ctx, ctx.gateway.takeEvents()[0]!).expect(200);

      const sub = await reload(subscriptionId);
      expect(sub.termCycles).toBe(3);
      expect(iso(sub.paidThroughAt)).toBe(iso(daysAfter(START, 84))); // 12 weeks
      expect((await payments(subscriptionId))[0]?.amountCents).toBe(13_230);
    });

    it('keeps the subscription unpaid when the first payment is declined, and records the failure', async () => {
      const { subscriptionId, sessionRef } = await checkout();
      ctx.gateway.completeCheckout(sessionRef, 'pm_declined');
      const response = await deliver(ctx, ctx.gateway.takeEvents()[0]!).expect(200);

      expect(response.body.result).toBe('recorded_only');
      const sub = await reload(subscriptionId);
      expect(sub).toMatchObject({ status: 'pending_payment', anchorAt: null, paidThroughAt: null });
      expect(await payments(subscriptionId)).toMatchObject([
        { type: 'failure', failureCode: 'card_declined' },
      ]);
    });
  });

  describe('duplicate and unrelated events', () => {
    it('applies an event once and answers 200 to every redelivery', async () => {
      const sub = await dueSubscription();
      const event = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D });

      const first = await deliver(ctx, event).expect(200);
      const afterFirst = await reload(sub.id);
      const second = await deliver(ctx, event).expect(200);

      expect([first.body.result, second.body.result]).toEqual(['applied', 'duplicate_event']);
      expect(await payments(sub.id)).toHaveLength(1);
      expect((await reload(sub.id)).version).toBe(afterFirst.version);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('applies an event once when five copies arrive at the same moment', async () => {
      const sub = await dueSubscription();
      const event = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D });

      const responses = await Promise.all(Array.from({ length: 5 }, () => deliver(ctx, event)));

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(responses.filter((r) => r.body.result === 'applied')).toHaveLength(1);
      expect(responses.filter((r) => r.body.result === 'duplicate_event')).toHaveLength(4);
      expect(await payments(sub.id)).toHaveLength(1);
      expect(await ctx.prisma.webhookEvent.count()).toBe(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('recognizes the same payment under a different event id', async () => {
      const sub = await dueSubscription();
      const event = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D });
      await deliver(ctx, event).expect(200);

      const resent = await deliver(ctx, { ...event, eventId: 'evt_resent_by_provider' }).expect(
        200,
      );
      expect(resent.body.result).toBe('already_recorded');
      expect(await payments(sub.id)).toHaveLength(1);
    });

    it('acknowledges an event type it does not handle without storing anything', async () => {
      const sub = await dueSubscription();
      const event = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D });
      jest.spyOn(ctx.gateway, 'parseWebhook').mockReturnValueOnce(null);

      const response = await deliver(ctx, event).expect(200);
      expect(response.body.result).toBe('ignored_type');
      expect(await ctx.prisma.webhookEvent.count()).toBe(0);
    });

    it.each([
      ['a payment this system did not create', (e: GatewayEvent) => ({ ...e, metadata: null })],
      [
        'an unknown subscription',
        (e: GatewayEvent) => ({
          ...e,
          metadata: { ...e.metadata!, subscriptionId: '00000000-0000-4000-8000-000000000000' },
        }),
      ],
      [
        'a malformed subscription id',
        (e: GatewayEvent) => ({
          ...e,
          metadata: { ...e.metadata!, subscriptionId: "x'; DROP TABLE" },
        }),
      ],
      [
        'a malformed period',
        (e: GatewayEvent) => ({ ...e, metadata: { ...e.metadata!, periodStart: 'yesterday-ish' } }),
      ],
    ])('acknowledges %s and records no payment', async (_name, mutate) => {
      const sub = await dueSubscription();
      const event = mutate(await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D }));

      await deliver(ctx, event).expect(200);

      expect(await ctx.prisma.payment.count()).toBe(0);
      expect(await ctx.prisma.webhookEvent.count()).toBe(1); // seen, so a retry storm cannot start
      expect((await reload(sub.id)).paidThroughAt).toEqual(D);
    });

    it('stores nothing when processing fails, so the provider retry is processed in full', async () => {
      const sub = await dueSubscription();
      const event = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D });
      jest
        .spyOn(ctx.app.get(SettlementService), 'settle')
        .mockRejectedValueOnce(new Error('database hiccup'));

      await deliver(ctx, event).expect(500);
      expect(await ctx.prisma.webhookEvent.count()).toBe(0);
      expect(await payments(sub.id)).toHaveLength(0);

      const retry = await deliver(ctx, event).expect(200);
      expect(retry.body.result).toBe('applied');
      expect(await payments(sub.id)).toHaveLength(1);
    });
  });

  describe('renewals', () => {
    it('continues the cycle from the due date on an on-time renewal and keeps the anchor', async () => {
      const sub = await dueSubscription();
      await deliver(
        ctx,
        await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: D }),
      ).expect(200);

      const after = await reload(sub.id);
      expect(iso(after.paidThroughAt)).toBe(iso(daysAfter(D, 28)));
      expect(after.anchorAt).toEqual(sub.anchorAt);
      expect(after.status).toBe('active');
    });

    it('does not shift the cycle when paid early', async () => {
      const sub = await dueSubscription();
      const early = daysAfter(D, -3);
      await deliver(
        ctx,
        await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: early }),
      ).expect(200);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('records a double payment for one renewal but never extends coverage twice', async () => {
      const sub = await dueSubscription();
      const first = await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: D });
      const second = await chargeEvent(ctx, {
        subscriptionId: sub.id,
        dueAt: D,
        idempotencyKey: 'a-different-key-by-mistake',
      });
      expect(second.gatewayRef).not.toBe(first.gatewayRef);

      expect((await deliver(ctx, first).expect(200)).body.result).toBe('applied');
      const afterFirst = await reload(sub.id);
      expect((await deliver(ctx, second).expect(200)).body.result).toBe('duplicate_charge');

      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(afterFirst.paidThroughAt));
      const rows = await payments(sub.id);
      expect(rows.map((r) => [r.type, r.amountCents])).toEqual([
        ['charge', 4900],
        ['charge', 4900],
      ]);
      expect(rows[1]?.periodStart).toBeNull();

      const { body } = await http()
        .get(`/admin/subscriptions/${sub.id}/ledger`)
        .set('x-admin-key', 'test-admin-key-0123456789')
        .expect(200);
      expect(body.chargedCents).toBe(9800); // the extra money is visible, so it can be refunded
    });
  });

  describe('dunning', () => {
    const fail = (subscriptionId: string, attempt: number, at: Date = D) =>
      chargeEvent(ctx, { subscriptionId, dueAt: D, attempt, at, paymentMethodRef: 'pm_declined' });

    it('moves a failed renewal to past_due and schedules the retry from the due date', async () => {
      const sub = await dueSubscription();
      await deliver(ctx, await fail(sub.id, 1)).expect(200);

      const after = await reload(sub.id);
      expect(after).toMatchObject({ status: 'past_due', failureCount: 1 });
      expect(iso(after.dueAt)).toBe(iso(D));
      expect(iso(after.nextRetryAt)).toBe(iso(daysAfter(D, 1)));
      expect(after.paidThroughAt).toEqual(D); // coverage is not extended
    });

    it('walks the +1, +3, +7 day schedule and cancels after the final failure', async () => {
      const sub = await dueSubscription();
      const expectedRetry = [1, 3, 7];

      for (const [index, days] of expectedRetry.entries()) {
        await deliver(ctx, await fail(sub.id, index + 1, daysAfter(D, index))).expect(200);
        const state = await reload(sub.id);
        expect(state.status).toBe('past_due');
        expect(iso(state.nextRetryAt)).toBe(iso(daysAfter(D, days)));
      }

      await deliver(ctx, await fail(sub.id, 4, daysAfter(D, 8))).expect(200);
      expect(await reload(sub.id)).toMatchObject({
        status: 'canceled',
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
        pendingStop: null,
      });
      expect((await payments(sub.id)).filter((p) => p.type === 'failure')).toHaveLength(4);
    });

    it('is not pushed back by failures delivered out of order', async () => {
      const sub = await dueSubscription();
      const attempt1 = await fail(sub.id, 1);
      const attempt2 = await fail(sub.id, 2, daysAfter(D, 1));

      await deliver(ctx, attempt2).expect(200);
      expect(await reload(sub.id)).toMatchObject({ status: 'past_due', failureCount: 2 });

      const late = await deliver(ctx, attempt1).expect(200);
      expect(late.body.result).toBe('recorded_only');
      const state = await reload(sub.id);
      expect(state.failureCount).toBe(2);
      expect(iso(state.nextRetryAt)).toBe(iso(daysAfter(D, 3)));
      expect((await payments(sub.id)).map((p) => p.attempt).sort()).toEqual([1, 2]); // both are in the ledger
    });

    it('restarts the cycle at the payment date when the customer pays late', async () => {
      const sub = await dueSubscription();
      await deliver(ctx, await fail(sub.id, 1)).expect(200);
      await deliver(ctx, await fail(sub.id, 2, daysAfter(D, 1))).expect(200);

      const latePayment = daysAfter(D, 5);
      const recovery = await chargeEvent(ctx, {
        subscriptionId: sub.id,
        dueAt: D,
        attempt: 3,
        at: latePayment,
      });
      await deliver(ctx, recovery).expect(200);

      const after = await reload(sub.id);
      expect(after).toMatchObject({
        status: 'active',
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
      });
      expect(iso(after.paidThroughAt)).toBe(iso(daysAfter(latePayment, 28))); // D+33, not D+28
      expect(after.anchorAt).toEqual(sub.anchorAt);

      const charge = (await payments(sub.id)).find((p) => p.type === 'charge');
      expect(iso(charge!.periodStart)).toBe(iso(latePayment));
    });

    it('does not move an active subscription back to past_due when an old failure arrives after recovery', async () => {
      const sub = await dueSubscription();
      const attempt1 = await fail(sub.id, 1);
      const recovery = await chargeEvent(ctx, {
        subscriptionId: sub.id,
        dueAt: D,
        attempt: 2,
        at: daysAfter(D, 1),
      });

      await deliver(ctx, recovery).expect(200);
      const recovered = await reload(sub.id);
      const late = await deliver(ctx, attempt1).expect(200);

      expect(late.body.result).toBe('recorded_only');
      const after = await reload(sub.id);
      expect(after.status).toBe('active');
      expect(after.paidThroughAt).toEqual(recovered.paidThroughAt);
      expect((await payments(sub.id)).map((p) => p.type).sort()).toEqual(['charge', 'failure']);
    });
  });

  describe('subscriptions in other states', () => {
    it('records money that cleared for a canceled subscription without granting coverage', async () => {
      const sub = await dueSubscription({ status: 'canceled' });
      const response = await deliver(
        ctx,
        await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: D }),
      ).expect(200);

      expect(response.body.result).toBe('recorded_only');
      const after = await reload(sub.id);
      expect(after.status).toBe('canceled');
      expect(after.paidThroughAt).toEqual(D);
      expect(await payments(sub.id)).toMatchObject([{ type: 'charge', amountCents: 4900 }]);
    });

    it('resumes a paused subscription when a payment clears, restarting the cycle at the payment date', async () => {
      const sub = await dueSubscription({ status: 'paused' });
      const paidAt = daysAfter(D, 10);
      await deliver(
        ctx,
        await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: paidAt }),
      ).expect(200);

      const after = await reload(sub.id);
      expect(after.status).toBe('active');
      expect(iso(after.paidThroughAt)).toBe(iso(daysAfter(paidAt, 28)));
    });

    it.each(['paused', 'canceled'] as const)(
      'only records a failure for a %s subscription',
      async (status) => {
        const sub = await dueSubscription({ status });
        await deliver(
          ctx,
          await chargeEvent(ctx, {
            subscriptionId: sub.id,
            dueAt: D,
            paymentMethodRef: 'pm_declined',
          }),
        ).expect(200);

        expect((await reload(sub.id)).status).toBe(status);
        expect(await payments(sub.id)).toMatchObject([{ type: 'failure' }]);
      },
    );

    it('bumps the version so a concurrent pause or cancel notices the change', async () => {
      const sub = await dueSubscription();
      await deliver(
        ctx,
        await chargeEvent(ctx, { subscriptionId: sub.id, dueAt: D, at: D }),
      ).expect(200);
      expect((await reload(sub.id)).version).toBe(sub.version + 1);
    });
  });
});
