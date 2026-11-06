import request from 'supertest';
import { chargeIdempotencyKey } from '@billing/domain';
import { GatewayError } from '@billing/gateway';
import { Subscription } from '@prisma/client';
import { RenewalsService } from '../../src/renewals/renewals.service';
import {
  ADMIN_KEY,
  createTestApp,
  daysAfter,
  deliver,
  makePlan,
  makeSubscription,
  resetDb,
  START,
  TestContext,
} from './harness';

describe('Renewals and dunning (e2e)', () => {
  let ctx: TestContext;
  let planCount = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.gateway.reset();
    ctx.clock.current = new Date(START);
  });

  const D = START; // a renewal is due at D
  const runDue = () => ctx.app.get(RenewalsService).runDue();
  const reload = (id: string) => ctx.prisma.subscription.findUniqueOrThrow({ where: { id } });
  const ledger = (id: string) =>
    ctx.prisma.payment.findMany({
      where: { subscriptionId: id },
      orderBy: [{ attempt: 'asc' }, { createdAt: 'asc' }],
    });
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const key = (id: string, attempt = 1, dueAt = D) =>
    chargeIdempotencyKey(id, dueAt.toISOString(), attempt);

  /** An active subscription with a saved card whose paid cycle ends at `paidThroughAt`. */
  async function dueSub(over: Partial<Subscription> = {}, planOver = {}): Promise<Subscription> {
    const plan = await makePlan(ctx.prisma, { name: `Standard ${(planCount += 1)}`, ...planOver });
    const sub = await makeSubscription(ctx.prisma, plan.id, {
      status: 'active',
      anchorAt: daysAfter(D, -28),
      paidThroughAt: D,
      paymentMethodRef: 'pm_ok',
      ...over,
    });
    await ctx.prisma.customer.update({
      where: { id: sub.customerId },
      data: { stripeCustomerId: `cus_fake_test_${planCount}` },
    });
    return sub;
  }

  describe('renewing', () => {
    it('charges a due subscription and extends coverage by one cycle from the due date', async () => {
      const sub = await dueSub();
      const summary = await runDue();

      expect(summary).toEqual({
        examined: 1,
        charged: 1,
        failed: 0,
        paused: 0,
        canceled: 0,
        skipped: 0,
        unknownOutcome: 0,
        errors: 0,
      });
      const after = await reload(sub.id);
      expect(after.status).toBe('active');
      expect(iso(after.paidThroughAt)).toBe(iso(daysAfter(D, 28)));
      expect(after.anchorAt).toEqual(sub.anchorAt);

      const [row] = await ledger(sub.id);
      expect(row).toMatchObject({
        type: 'charge',
        amountCents: 4900,
        attempt: 1,
        idempotencyKey: key(sub.id),
      });
      expect(iso(row!.periodStart)).toBe(iso(D));
      expect(ctx.gateway.charges).toHaveLength(1);
      expect(ctx.gateway.charges[0]).toMatchObject({
        amountCents: 4900,
        currency: 'usd',
        paymentMethodRef: 'pm_ok',
      });
    });

    it('charges the discounted total for a prepaid term and covers all of it', async () => {
      const sub = await dueSub({ termCycles: 3 });
      await runDue();
      expect(ctx.gateway.charges[0]?.amountCents).toBe(13_230);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 84)));
    });

    it('does nothing while coverage remains', async () => {
      await dueSub();
      ctx.clock.current = new Date(D.getTime() - 3_600_000);
      expect(await runDue()).toMatchObject({ examined: 0, charged: 0 });
      expect(ctx.gateway.charges).toHaveLength(0);
    });

    it('ignores subscriptions that are not active or past due', async () => {
      for (const status of ['pending_payment', 'paused', 'canceled'] as const)
        await dueSub({ status });
      expect(await runDue()).toMatchObject({ examined: 0 });
      expect(ctx.gateway.charges).toHaveLength(0);
    });
  });

  describe('running the job more than once', () => {
    it('charges once when it runs twice in a row', async () => {
      const sub = await dueSub();
      await runDue();
      expect(await runDue()).toMatchObject({ examined: 0 });
      expect(ctx.gateway.charges).toHaveLength(1);
      expect(await ledger(sub.id)).toHaveLength(1);
    });

    it('charges once when two runs both reach the provider before either records the result', async () => {
      const sub = await dueSub();

      // Hold both runs at the provider until each has arrived, so the overlap is real.
      const original = ctx.gateway.chargeOffSession.bind(ctx.gateway);
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      jest.spyOn(ctx.gateway, 'chargeOffSession').mockImplementation(async (input) => {
        arrived += 1;
        if (arrived === 2) open();
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 3000))]);
        return original(input);
      });

      const summaries = await Promise.all([runDue(), runDue()]);

      expect(arrived).toBe(2); // both runs really did call the provider
      expect(summaries.map((s) => s.errors)).toEqual([0, 0]);
      expect(ctx.gateway.charges).toHaveLength(1); // the second call was a replay of the first
      expect(await ledger(sub.id)).toHaveLength(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28))); // extended once, not twice
    });

    it('charges once when several runs are started together', async () => {
      const sub = await dueSub();
      const summaries = await Promise.all([runDue(), runDue(), runDue()]);

      expect(summaries.every((s) => s.errors === 0)).toBe(true);
      expect(ctx.gateway.charges).toHaveLength(1);
      expect(await ledger(sub.id)).toHaveLength(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('charges once when the provider answer is lost, however many times the job retries', async () => {
      const sub = await dueSub();
      ctx.gateway.loseNextResponse();

      expect(await runDue()).toMatchObject({ unknownOutcome: 1, charged: 0, errors: 0 });
      expect(ctx.gateway.charges).toHaveLength(1); // the provider did charge
      const untouched = await reload(sub.id);
      expect(iso(untouched.paidThroughAt)).toBe(iso(D)); // but we recorded nothing yet
      expect(await ledger(sub.id)).toHaveLength(0);

      expect(await runDue()).toMatchObject({ charged: 1, unknownOutcome: 0 });
      expect(ctx.gateway.charges).toHaveLength(1); // the repeat was a replay
      expect(await ledger(sub.id)).toHaveLength(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('records nothing during a provider outage and charges normally once it ends', async () => {
      const sub = await dueSub();
      ctx.gateway.setOutage(true);
      expect(await runDue()).toMatchObject({ unknownOutcome: 1 });
      expect(ctx.gateway.charges).toHaveLength(0);
      expect((await reload(sub.id)).status).toBe('active');
      expect(await ledger(sub.id)).toHaveLength(0);

      ctx.gateway.setOutage(false);
      expect(await runDue()).toMatchObject({ charged: 1 });
      expect(ctx.gateway.charges).toHaveLength(1);
    });

    it('is a no-op for the job when the webhook already recorded the payment', async () => {
      const sub = await dueSub();
      ctx.gateway.loseNextResponse();
      await runDue(); // charged at the provider, answer lost
      const [event] = ctx.gateway.takeEvents();

      expect((await deliver(ctx, event!).expect(200)).body.result).toBe('applied');
      expect(await runDue()).toMatchObject({ examined: 0 });
      expect(ctx.gateway.charges).toHaveLength(1);
      expect(await ledger(sub.id)).toHaveLength(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });

    it('treats the webhook as a no-op when the job already recorded the payment', async () => {
      const sub = await dueSub();
      await runDue();
      const [event] = ctx.gateway.takeEvents();

      expect((await deliver(ctx, event!).expect(200)).body.result).toBe('already_recorded');
      expect(await ledger(sub.id)).toHaveLength(1);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });
  });

  describe('failed renewals and dunning', () => {
    it('moves a declined renewal to past_due without extending coverage', async () => {
      const sub = await dueSub({ paymentMethodRef: 'pm_declined' });
      expect(await runDue()).toMatchObject({ failed: 1, charged: 0 });

      const after = await reload(sub.id);
      expect(after).toMatchObject({ status: 'past_due', failureCount: 1 });
      expect(iso(after.paidThroughAt)).toBe(iso(D));
      expect(iso(after.nextRetryAt)).toBe(iso(daysAfter(D, 1)));
      expect(await ledger(sub.id)).toMatchObject([
        { type: 'failure', failureCode: 'card_declined', attempt: 1, idempotencyKey: key(sub.id) },
      ]);
      expect(await runDue()).toMatchObject({ examined: 0 }); // the retry is not due yet
    });

    it('retries at +1, +3 and +7 days, then cancels', async () => {
      const sub = await dueSub({ paymentMethodRef: 'pm_declined' });
      const steps: Array<[number, string | null]> = [
        [0, iso(daysAfter(D, 1))],
        [1, iso(daysAfter(D, 3))],
        [3, iso(daysAfter(D, 7))],
      ];

      for (const [offset, nextRetry] of steps) {
        ctx.clock.current = daysAfter(D, offset);
        expect(await runDue()).toMatchObject({ failed: 1 });
        const state = await reload(sub.id);
        expect(state.status).toBe('past_due');
        expect(iso(state.nextRetryAt)).toBe(nextRetry);
      }

      ctx.clock.current = daysAfter(D, 7);
      expect(await runDue()).toMatchObject({ failed: 1 });
      expect(await reload(sub.id)).toMatchObject({
        status: 'canceled',
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
      });

      const rows = await ledger(sub.id);
      expect(rows.map((r) => [r.type, r.attempt, r.idempotencyKey])).toEqual(
        [1, 2, 3, 4].map((a) => ['failure', a, key(sub.id, a)]),
      );
      expect(ctx.gateway.charges).toHaveLength(4);

      ctx.clock.current = daysAfter(D, 60);
      expect(await runDue()).toMatchObject({ examined: 0 }); // a canceled subscription is never charged again
      expect(ctx.gateway.charges).toHaveLength(4);
    });

    it('restarts the cycle at the payment date when a retry succeeds', async () => {
      ctx.gateway.script('pm_flaky', [{ decline: 'card_declined' }], 'ok');
      const sub = await dueSub({ paymentMethodRef: 'pm_flaky' });

      await runDue(); // attempt 1 fails at D
      const retryAt = new Date(daysAfter(D, 1).getTime() + 2 * 3_600_000);
      ctx.clock.current = retryAt;
      expect(await runDue()).toMatchObject({ charged: 1 });

      const after = await reload(sub.id);
      expect(after).toMatchObject({
        status: 'active',
        failureCount: 0,
        dueAt: null,
        nextRetryAt: null,
      });
      expect(iso(after.paidThroughAt)).toBe(iso(daysAfter(retryAt, 28))); // from the payment, not from D
      expect(after.anchorAt).toEqual(sub.anchorAt);

      const rows = await ledger(sub.id);
      expect(rows.map((r) => [r.type, r.attempt])).toEqual([
        ['failure', 1],
        ['charge', 2],
      ]);
      expect(iso(rows[1]!.periodStart)).toBe(iso(retryAt));
    });

    it('records a missing payment method as a failure, without calling the provider', async () => {
      const sub = await dueSub({ paymentMethodRef: null });
      expect(await runDue()).toMatchObject({ failed: 1 });

      expect(ctx.gateway.charges).toHaveLength(0);
      expect((await reload(sub.id)).status).toBe('past_due');
      expect(await ledger(sub.id)).toMatchObject([
        { type: 'failure', failureCode: 'no_payment_method', gatewayRef: null },
      ]);
      expect(await runDue()).toMatchObject({ examined: 0 });
    });
  });

  describe('scheduled pause and cancel', () => {
    it.each([
      ['cancel', 'canceled'],
      ['pause', 'paused'],
    ] as const)(
      'applies a scheduled %s at the end of the paid cycle instead of charging',
      async (pendingStop, status) => {
        const sub = await dueSub({ pendingStop });
        const summary = await runDue();

        expect(summary).toMatchObject({ [status]: 1, charged: 0 });
        expect(await reload(sub.id)).toMatchObject({ status, pendingStop: null });
        expect(ctx.gateway.charges).toHaveLength(0);
        expect(await ledger(sub.id)).toHaveLength(0); // no charge, and no refund either
      },
    );
  });

  describe('problems that need a person', () => {
    it('does not charge when the plan can no longer price the chosen term', async () => {
      const sub = await dueSub({ termCycles: 3 }, { terms: { create: [] } });
      expect(await runDue()).toMatchObject({ errors: 1, charged: 0 });
      expect(ctx.gateway.charges).toHaveLength(0);
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(D));
    });

    it('keeps going when one subscription fails with a provider error', async () => {
      const first = await dueSub({ paidThroughAt: daysAfter(D, -2) });
      const second = await dueSub({ paidThroughAt: daysAfter(D, -1) });
      jest
        .spyOn(ctx.gateway, 'chargeOffSession')
        .mockRejectedValueOnce(new GatewayError('rejected request'));

      expect(await runDue()).toMatchObject({ examined: 2, errors: 1, charged: 1 });
      expect(iso((await reload(first.id)).paidThroughAt)).toBe(iso(daysAfter(D, -2))); // left alone, not cancelled
      expect((await reload(first.id)).status).toBe('active');
      // Its cycle ended a day before the job ran, so the payment is late and restarts at the payment date.
      expect(iso((await reload(second.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });
  });

  describe('POST /admin/renewals/run', () => {
    it('requires the admin key', async () => {
      await dueSub();
      await request(ctx.app.getHttpServer()).post('/admin/renewals/run').expect(401);
      expect(ctx.gateway.charges).toHaveLength(0);
    });

    it('runs the job and returns its summary', async () => {
      const sub = await dueSub();
      const { body } = await request(ctx.app.getHttpServer())
        .post('/admin/renewals/run')
        .set('x-admin-key', ADMIN_KEY)
        .expect(200);

      expect(body).toMatchObject({ examined: 1, charged: 1, errors: 0 });
      expect(iso((await reload(sub.id)).paidThroughAt)).toBe(iso(daysAfter(D, 28)));
    });
  });
});
