import request from 'supertest';
import { Subscription } from '@prisma/client';
import {
  ADMIN_KEY,
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

/**
 * Whole customer stories, told through the public API. Time is a controlled
 * clock, the provider is the fake, and webhooks are delivered the way the
 * provider would deliver them. Every story ends by reconciling the ledger
 * against what the provider says it actually charged and refunded.
 */
describe('Subscription lifecycle (e2e)', () => {
  let ctx: TestContext;
  let planId: string;

  const http = () => request(ctx.app.getHttpServer());
  const admin = (r: request.Test) => r.set('x-admin-key', ADMIN_KEY);

  // A customer pays at 09:30 on 1 January. Cycles are 28 days from that moment.
  const T0 = new Date('2026-01-01T09:30:00.000Z');
  const at = (days: number, hours = 0) =>
    new Date(T0.getTime() + days * 86_400_000 + hours * 3_600_000);
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.gateway.reset();
    ctx.clock.current = new Date(T0);
    const { body } = await admin(http().post('/admin/plans')).send({
      name: 'Standard',
      priceCents: 4900,
      currency: 'usd',
      terms: [
        { cycles: 3, discountBps: 1000 },
        { cycles: 6, discountBps: 1500 },
      ],
    });
    planId = body.id;
  });

  /** Checkout, pay on the hosted page, and let the provider's webhook arrive. */
  async function signUp(
    o: { termCycles?: number; card?: string; paidAt?: Date } = {},
  ): Promise<string> {
    const { body } = await http()
      .post('/subscriptions/checkout')
      .send({
        email: 'ana@example.test',
        planId,
        ...(o.termCycles ? { termCycles: o.termCycles } : {}),
      })
      .expect(201);
    ctx.clock.current = new Date(o.paidAt ?? T0);
    ctx.gateway.completeCheckout(body.checkoutUrl.split('/').pop(), o.card ?? 'pm_ok');
    for (const event of ctx.gateway.takeEvents()) await deliver(ctx, event).expect(200);
    return body.subscriptionId;
  }

  /** Runs the renewal job at `when`, then delivers the webhooks its charges caused. */
  async function runRenewals(when: Date) {
    ctx.clock.current = new Date(when);
    const { body } = await admin(http().post('/admin/renewals/run')).expect(200);
    for (const event of ctx.gateway.takeEvents()) {
      // The job already recorded these payments, so the webhook must change nothing.
      expect((await deliver(ctx, event).expect(200)).body.result).toBe('already_recorded');
    }
    return body as Record<string, number>;
  }

  const getSub = async (id: string) => (await http().get(`/subscriptions/${id}`).expect(200)).body;
  const getLedger = async (id: string) =>
    (await admin(http().get(`/admin/subscriptions/${id}/ledger`)).expect(200)).body;

  /** The ledger must agree with the provider about every cent charged, failed and refunded. */
  async function expectLedgerMatchesProvider(subscriptionId: string) {
    const ledger = await getLedger(subscriptionId);
    const mine = ctx.gateway.charges.filter((c) => c.metadata.subscriptionId === subscriptionId);
    const succeeded = mine.filter((c) => c.status === 'succeeded');
    const refunded = ctx.gateway.refunds.filter((r) =>
      succeeded.some((c) => c.gatewayRef === r.gatewayRef),
    );

    expect(ledger.chargedCents).toBe(succeeded.reduce((sum, c) => sum + c.amountCents, 0));
    expect(ledger.refundedCents).toBe(refunded.reduce((sum, r) => sum + r.amountCents, 0));
    expect(ledger.entries.filter((e: { type: string }) => e.type === 'failure')).toHaveLength(
      mine.filter((c) => c.status === 'failed').length,
    );
    expect(ledger.entries.filter((e: { type: string }) => e.type === 'charge')).toHaveLength(
      succeeded.length,
    );
  }

  it('follows a loyal customer: checkout, two renewals, then a cancel that waits for the cycle to end', async () => {
    const id = await signUp();

    let sub = await getSub(id);
    expect(sub).toMatchObject({ status: 'active', pendingStop: null });
    expect(sub.anchorAt).toBe(iso(T0));
    expect(sub.paidThroughAt).toBe(iso(at(28)));

    expect(await runRenewals(at(27))).toMatchObject({ examined: 0 }); // a day early: nothing happens

    expect(await runRenewals(at(28))).toMatchObject({ charged: 1 });
    sub = await getSub(id);
    expect(sub.paidThroughAt).toBe(iso(at(56))); // continues from the due date
    expect(sub.anchorAt).toBe(iso(T0)); // the anchor never moves

    // Cancelling mid-cycle keeps the paid cycle and refunds nothing.
    ctx.clock.current = at(40);
    const cancel = await http().post(`/subscriptions/${id}/cancel`).expect(200);
    expect(cancel.body).toMatchObject({
      status: 'active',
      pendingStop: 'cancel',
      effectiveAt: iso(at(56)),
    });
    expect(await runRenewals(at(55))).toMatchObject({ examined: 0 });

    expect(await runRenewals(at(56))).toMatchObject({ canceled: 1, charged: 0 });
    expect(await getSub(id)).toMatchObject({ status: 'canceled', pendingStop: null });

    expect(await runRenewals(at(90))).toMatchObject({ examined: 0 }); // never charged again
    expect(ctx.gateway.successfulCharges()).toHaveLength(2);
    expect(await getLedger(id)).toMatchObject({
      chargedCents: 9800,
      refundedCents: 0,
      netCents: 9800,
    });
    await expectLedgerMatchesProvider(id);
  });

  it('follows a card that works at checkout and fails at renewal, until the customer fixes it', async () => {
    const id = await signUp({ card: 'pm_fails_after_first' });
    expect((await getSub(id)).status).toBe('active');

    // The renewal is declined: past due, with the next attempt announced.
    expect(await runRenewals(at(28))).toMatchObject({ failed: 1 });
    let sub = await getSub(id);
    expect(sub).toMatchObject({
      status: 'past_due',
      paidThroughAt: iso(at(28)),
      nextRetryAt: iso(at(29)),
    });

    // Still declined the next day.
    expect(await runRenewals(at(29))).toMatchObject({ failed: 1 });
    expect((await getSub(id)).nextRetryAt).toBe(iso(at(31)));

    // The customer replaces the card; the third attempt, a few hours late, goes through.
    ctx.gateway.script('pm_fails_after_first', [], 'ok');
    expect(await runRenewals(at(31, 0.5))).toMatchObject({ charged: 1 });

    sub = await getSub(id);
    expect(sub).toMatchObject({ status: 'active', nextRetryAt: null });
    expect(sub.paidThroughAt).toBe(iso(at(59, 0.5))); // 28 days from the payment, not from day 28
    expect(sub.anchorAt).toBe(iso(T0));

    const ledger = await getLedger(id);
    expect(
      ledger.entries.map((e: { type: string; attempt: number }) => `${e.type}#${e.attempt}`),
    ).toEqual(['charge#1', 'failure#1', 'failure#2', 'charge#3']);
    expect(ledger).toMatchObject({ chargedCents: 9800, netCents: 9800 });
    await expectLedgerMatchesProvider(id);
  });

  it('follows a card that never recovers: four attempts, then a clean cancel', async () => {
    const id = await signUp({ card: 'pm_fails_after_first' });

    for (const [day, retry] of [
      [28, 29],
      [29, 31],
      [31, 35],
    ] as const) {
      expect(await runRenewals(at(day))).toMatchObject({ failed: 1 });
      expect(await getSub(id)).toMatchObject({ status: 'past_due', nextRetryAt: iso(at(retry)) });
    }

    expect(await runRenewals(at(35))).toMatchObject({ failed: 1 });
    expect(await getSub(id)).toMatchObject({ status: 'canceled', nextRetryAt: null });

    expect(await runRenewals(at(80))).toMatchObject({ examined: 0 });
    expect(ctx.gateway.charges).toHaveLength(5); // the first payment plus exactly four renewal attempts

    const ledger = await getLedger(id);
    expect(ledger).toMatchObject({ chargedCents: 4900, netCents: 4900 });
    expect(ledger.entries.filter((e: { type: string }) => e.type === 'failure')).toHaveLength(4);
    await expectLedgerMatchesProvider(id);
  });

  it('follows a prepaid 12-week term, with a pause that waits for the term to end', async () => {
    const id = await signUp({ termCycles: 3 });
    const paid = await getSub(id);
    expect(paid).toMatchObject({ status: 'active', termCycles: 3 });
    expect(paid.paidThroughAt).toBe(iso(at(84)));

    ctx.clock.current = at(30);
    const pause = await http().post(`/subscriptions/${id}/pause`).expect(200);
    expect(pause.body).toMatchObject({
      status: 'active',
      pendingStop: 'pause',
      effectiveAt: iso(at(84)),
    });

    expect(await runRenewals(at(60))).toMatchObject({ examined: 0 }); // nothing is owed mid-term
    expect(await runRenewals(at(84))).toMatchObject({ paused: 1, charged: 0 });
    expect(await getSub(id)).toMatchObject({ status: 'paused', pendingStop: null });

    expect(await runRenewals(at(120))).toMatchObject({ examined: 0 }); // a paused subscription is not charged
    expect(await getLedger(id)).toMatchObject({ chargedCents: 13_230, refundedCents: 0 }); // 3 cycles, 10% off, paid once
    await expectLedgerMatchesProvider(id);
  });

  it('keeps an admin refund separate from the subscription and visible in the ledger', async () => {
    const id = await signUp();
    const ledgerBefore = await getLedger(id);
    const chargeId = ledgerBefore.entries[0].id;

    const refund = await admin(http().post(`/admin/payments/${chargeId}/refund`))
      .send({ amountCents: 1000 })
      .expect(201);
    expect(refund.body).toMatchObject({ refundedCents: 1000, remainingCents: 3900 });

    expect(await getSub(id)).toMatchObject({ status: 'active', paidThroughAt: iso(at(28)) }); // coverage untouched
    expect(await getLedger(id)).toMatchObject({
      chargedCents: 4900,
      refundedCents: 1000,
      netCents: 3900,
    });
    expect(await runRenewals(at(28))).toMatchObject({ charged: 1 }); // and renewal carries on as normal
    await expectLedgerMatchesProvider(id);
  });

  describe('webhook delivery does not change the outcome', () => {
    const permutations = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );

    async function dueSub(): Promise<Subscription> {
      const plan = await makePlan(ctx.prisma, { name: `Plan ${Math.random()}` });
      const sub = await makeSubscription(ctx.prisma, plan.id, {
        status: 'active',
        anchorAt: daysAfter(START, -28),
        paidThroughAt: START,
        paymentMethodRef: 'pm_ok',
      });
      return sub;
    }

    it('ends in the same state for every arrival order, with every event delivered twice', async () => {
      const D = START;
      const finalStates: unknown[] = [];

      for (const order of permutations([0, 1, 2])) {
        await resetDb(ctx.prisma);
        ctx.gateway.reset();
        const sub = await dueSub();

        // Two declines, then a late payment that goes through.
        const events = [
          await chargeEvent(ctx, {
            subscriptionId: sub.id,
            dueAt: D,
            attempt: 1,
            at: D,
            paymentMethodRef: 'pm_declined',
          }),
          await chargeEvent(ctx, {
            subscriptionId: sub.id,
            dueAt: D,
            attempt: 2,
            at: daysAfter(D, 1),
            paymentMethodRef: 'pm_declined',
          }),
          await chargeEvent(ctx, {
            subscriptionId: sub.id,
            dueAt: D,
            attempt: 3,
            at: daysAfter(D, 4),
          }),
        ];

        const sequence = [...order.map((i) => events[i]!), ...events]; // permuted, then every event again
        for (const event of sequence) await deliver(ctx, event).expect(200);

        const state = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
        const rows = await ctx.prisma.payment.findMany({
          where: { subscriptionId: sub.id },
          orderBy: { attempt: 'asc' },
        });
        finalStates.push({
          status: state.status,
          failureCount: state.failureCount,
          dueAt: state.dueAt,
          nextRetryAt: state.nextRetryAt,
          paidThroughAt: iso(state.paidThroughAt),
          anchorAt: iso(state.anchorAt),
          ledger: rows.map((r) => `${r.type}#${r.attempt}`),
        });
      }

      expect(finalStates[0]).toEqual({
        status: 'active',
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
        paidThroughAt: iso(daysAfter(D, 32)), // restarted at the payment date, D+4, plus 28 days
        anchorAt: iso(daysAfter(D, -28)),
        ledger: ['failure#1', 'failure#2', 'charge#3'],
      });
      expect(new Set(finalStates.map((s) => JSON.stringify(s))).size).toBe(1); // all six orders agree
    });
  });
});
