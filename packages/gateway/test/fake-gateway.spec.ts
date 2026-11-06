import {
  FakeGateway,
  GatewayError,
  GatewayUnavailableError,
  InvalidSignatureError,
  OffSessionChargeInput,
  PaymentMetadata,
} from '../src';

const metadata = (attempt = 1): PaymentMetadata => ({
  subscriptionId: 'sub_1',
  periodStart: '2025-01-01T00:00:00.000Z',
  attempt,
});

const charge = (over: Partial<OffSessionChargeInput> = {}): OffSessionChargeInput => ({
  customerRef: 'cus_1',
  paymentMethodRef: 'pm_ok',
  amountCents: 4900,
  currency: 'usd',
  description: 'Standard, 4 weeks',
  metadata: metadata(),
  idempotencyKey: 'sub_1:2025-01-01:1',
  ...over,
});

const checkoutInput = (over = {}) => ({
  customerRef: 'cus_1',
  amountCents: 13_230,
  currency: 'usd',
  description: 'Standard, 12 weeks',
  successUrl: 'https://example.test/ok',
  cancelUrl: 'https://example.test/cancel',
  metadata: metadata(),
  idempotencyKey: 'checkout:sub_1',
  ...over,
});

describe('FakeGateway card outcomes', () => {
  it('succeeds for a good card', async () => {
    const gw = new FakeGateway();
    await expect(gw.chargeOffSession(charge())).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('returns a decline as a result, not an exception', async () => {
    const gw = new FakeGateway();
    await expect(
      gw.chargeOffSession(charge({ paymentMethodRef: 'pm_declined' })),
    ).resolves.toMatchObject({ status: 'failed', failureCode: 'card_declined' });
    await expect(
      gw.chargeOffSession(
        charge({ paymentMethodRef: 'pm_insufficient_funds', idempotencyKey: 'k2' }),
      ),
    ).resolves.toMatchObject({ failureCode: 'insufficient_funds' });
  });

  it('succeeds once then declines for pm_fails_after_first', async () => {
    const gw = new FakeGateway();
    const pm = 'pm_fails_after_first';
    const first = await gw.chargeOffSession(charge({ paymentMethodRef: pm, idempotencyKey: 'a' }));
    const second = await gw.chargeOffSession(charge({ paymentMethodRef: pm, idempotencyKey: 'b' }));
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('failed');
  });

  it('follows a custom script', async () => {
    const gw = new FakeGateway();
    gw.script(
      'pm_custom',
      ['ok', { decline: 'card_declined' }, { decline: 'card_declined' }],
      'ok',
    );
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await gw.chargeOffSession(
        charge({ paymentMethodRef: 'pm_custom', idempotencyKey: `k${i}` }),
      );
      statuses.push(r.status);
    }
    expect(statuses).toEqual(['succeeded', 'failed', 'failed', 'succeeded']);
  });

  it('defaults a scripted card to succeeding once its queue is empty', async () => {
    const gw = new FakeGateway();
    gw.script('pm_once_declined', [{ decline: 'card_declined' }]);
    const first = await gw.chargeOffSession(
      charge({ paymentMethodRef: 'pm_once_declined', idempotencyKey: 'a' }),
    );
    const second = await gw.chargeOffSession(
      charge({ paymentMethodRef: 'pm_once_declined', idempotencyKey: 'b' }),
    );
    expect([first.status, second.status]).toEqual(['failed', 'succeeded']);
  });

  it('declines an unknown payment method', async () => {
    const gw = new FakeGateway();
    await expect(
      gw.chargeOffSession(charge({ paymentMethodRef: 'pm_nope' })),
    ).resolves.toMatchObject({ status: 'failed', failureCode: 'payment_method_not_found' });
  });
});

describe('FakeGateway.reset', () => {
  it('forgets charges, refunds, events, replay history, scripts and outages', async () => {
    const gw = new FakeGateway();
    const paid = await gw.chargeOffSession(charge());
    await gw.refund({
      gatewayRef: paid.status === 'succeeded' ? paid.gatewayRef : '',
      amountCents: 100,
      idempotencyKey: 'r1',
    });
    gw.script('pm_ok', [], { decline: 'card_declined' });
    gw.setOutage(true);
    gw.loseNextResponse();

    gw.reset();

    expect(gw.charges).toHaveLength(0);
    expect(gw.refunds).toHaveLength(0);
    expect(gw.takeEvents()).toHaveLength(0);
    // The same key is a fresh request now, not a replay, and pm_ok is a good card again.
    await expect(gw.chargeOffSession(charge())).resolves.toMatchObject({ status: 'succeeded' });
    expect(gw.charges).toHaveLength(1);
  });
});

describe('FakeGateway idempotency', () => {
  it('replays the first result and never charges twice for the same key', async () => {
    const gw = new FakeGateway();
    const a = await gw.chargeOffSession(charge());
    const b = await gw.chargeOffSession(charge());
    expect(b).toEqual(a);
    expect(gw.successfulCharges()).toHaveLength(1);
    expect(gw.takeEvents()).toHaveLength(1);
  });

  it('rejects the same key with different parameters', async () => {
    const gw = new FakeGateway();
    await gw.chargeOffSession(charge());
    await expect(gw.chargeOffSession(charge({ amountCents: 1 }))).rejects.toThrow(GatewayError);
  });

  it('replays a decline too', async () => {
    const gw = new FakeGateway();
    const input = charge({ paymentMethodRef: 'pm_fails_after_first' });
    gw.script('pm_fails_after_first', [{ decline: 'card_declined' }], 'ok');
    const first = await gw.chargeOffSession(input);
    const again = await gw.chargeOffSession(input);
    expect(first.status).toBe('failed');
    expect(again).toEqual(first);
  });

  it('replays customers and checkout sessions', async () => {
    const gw = new FakeGateway();
    const c1 = await gw.ensureCustomer({ email: 'a@example.test', idempotencyKey: 'cust:1' });
    const c2 = await gw.ensureCustomer({ email: 'a@example.test', idempotencyKey: 'cust:1' });
    expect(c2).toEqual(c1);
    const s1 = await gw.createCheckoutSession(checkoutInput());
    const s2 = await gw.createCheckoutSession(checkoutInput());
    expect(s2).toEqual(s1);
  });
});

describe('FakeGateway unknown outcomes', () => {
  it('throws GatewayUnavailableError during an outage and charges nothing', async () => {
    const gw = new FakeGateway();
    gw.setOutage(true);
    await expect(gw.chargeOffSession(charge())).rejects.toThrow(GatewayUnavailableError);
    expect(gw.charges).toHaveLength(0);
    gw.setOutage(false);
    await expect(gw.chargeOffSession(charge())).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('does not double charge when the response is lost and the call is retried', async () => {
    const gw = new FakeGateway();
    gw.loseNextResponse();
    await expect(gw.chargeOffSession(charge())).rejects.toThrow(GatewayUnavailableError);
    expect(gw.successfulCharges()).toHaveLength(1); // the provider did charge
    const retry = await gw.chargeOffSession(charge());
    expect(retry.status).toBe('succeeded');
    expect(gw.successfulCharges()).toHaveLength(1); // and the retry did not charge again
  });

  it('also blocks customer and checkout calls during an outage', async () => {
    const gw = new FakeGateway();
    gw.setOutage(true);
    await expect(
      gw.ensureCustomer({ email: 'a@example.test', idempotencyKey: 'c1' }),
    ).rejects.toThrow(GatewayUnavailableError);
    await expect(gw.createCheckoutSession(checkoutInput())).rejects.toThrow(
      GatewayUnavailableError,
    );
  });

  it('does not refund twice when the refund response is lost and the call is retried', async () => {
    const gw = new FakeGateway();
    const paid = await gw.chargeOffSession(charge());
    const gatewayRef = paid.status === 'succeeded' ? paid.gatewayRef : '';
    gw.loseNextResponse();
    const refund = { gatewayRef, amountCents: 1000, idempotencyKey: 'r1' };
    await expect(gw.refund(refund)).rejects.toThrow(GatewayUnavailableError);
    expect(gw.refunds).toHaveLength(1); // the provider did refund
    await expect(gw.refund(refund)).resolves.toMatchObject({ status: 'succeeded' });
    expect(gw.refunds).toHaveLength(1); // and the retry did not refund again
  });

  it('also blocks refunds during an outage', async () => {
    const gw = new FakeGateway();
    const paid = await gw.chargeOffSession(charge());
    gw.setOutage(true);
    await expect(
      gw.refund({
        gatewayRef: paid.status === 'succeeded' ? paid.gatewayRef : '',
        amountCents: 100,
        idempotencyKey: 'r1',
      }),
    ).rejects.toThrow(GatewayUnavailableError);
  });
});

describe('FakeGateway checkout', () => {
  it('completes a checkout, saves the card on the event and emits payment.succeeded', async () => {
    const gw = new FakeGateway();
    const { sessionRef, url } = await gw.createCheckoutSession(checkoutInput());
    expect(url).toContain(sessionRef);
    const result = gw.completeCheckout(sessionRef, 'pm_ok');
    expect(result.status).toBe('succeeded');
    const [event] = gw.takeEvents();
    expect(event).toMatchObject({
      type: 'payment.succeeded',
      amountCents: 13_230,
      paymentMethodRef: 'pm_ok',
      metadata: { subscriptionId: 'sub_1', attempt: 1 },
    });
  });

  it('emits payment.failed when the first payment is declined', async () => {
    const gw = new FakeGateway();
    const { sessionRef } = await gw.createCheckoutSession(checkoutInput());
    expect(gw.completeCheckout(sessionRef, 'pm_declined').status).toBe('failed');
    expect(gw.takeEvents()[0]).toMatchObject({
      type: 'payment.failed',
      failureCode: 'card_declined',
    });
  });

  it('rejects an unknown or already completed session', async () => {
    const gw = new FakeGateway();
    expect(() => gw.completeCheckout('cs_nope', 'pm_ok')).toThrow(GatewayError);
    const { sessionRef } = await gw.createCheckoutSession(checkoutInput());
    gw.completeCheckout(sessionRef, 'pm_ok');
    expect(() => gw.completeCheckout(sessionRef, 'pm_ok')).toThrow(GatewayError);
  });

  it('drains events once', async () => {
    const gw = new FakeGateway();
    await gw.chargeOffSession(charge());
    expect(gw.takeEvents()).toHaveLength(1);
    expect(gw.takeEvents()).toHaveLength(0);
  });
});

describe('FakeGateway refunds', () => {
  const paid = async (gw: FakeGateway) => {
    const r = await gw.chargeOffSession(charge());
    if (r.status !== 'succeeded') throw new Error('setup failed');
    return r.gatewayRef;
  };

  it('refunds partially and then fully, never beyond the charge', async () => {
    const gw = new FakeGateway();
    const ref = await paid(gw);
    await expect(
      gw.refund({ gatewayRef: ref, amountCents: 1000, idempotencyKey: 'r1' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      gw.refund({ gatewayRef: ref, amountCents: 3900, idempotencyKey: 'r2' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      gw.refund({ gatewayRef: ref, amountCents: 1, idempotencyKey: 'r3' }),
    ).rejects.toThrow('exceeds');
  });

  it('is idempotent per key', async () => {
    const gw = new FakeGateway();
    const ref = await paid(gw);
    const a = await gw.refund({ gatewayRef: ref, amountCents: 1000, idempotencyKey: 'r1' });
    const b = await gw.refund({ gatewayRef: ref, amountCents: 1000, idempotencyKey: 'r1' });
    expect(b).toEqual(a);
    expect(gw.refunds).toHaveLength(1);
  });

  it('refuses to refund a missing or failed charge', async () => {
    const gw = new FakeGateway();
    await expect(
      gw.refund({ gatewayRef: 'pi_nope', amountCents: 1, idempotencyKey: 'r1' }),
    ).rejects.toThrow(GatewayError);
    const failed = await gw.chargeOffSession(
      charge({ paymentMethodRef: 'pm_declined', idempotencyKey: 'f1' }),
    );
    expect(failed.status).toBe('failed');
    await expect(
      gw.refund({ gatewayRef: failed.gatewayRef ?? '', amountCents: 1, idempotencyKey: 'r2' }),
    ).rejects.toThrow(GatewayError);
  });
});

describe('FakeGateway webhooks', () => {
  it('round-trips a signed event, restoring the date', async () => {
    const gw = new FakeGateway({ now: () => new Date('2025-02-03T04:05:06.000Z') });
    await gw.chargeOffSession(charge());
    const [event] = gw.takeEvents();
    const { payload, signature } = gw.sign(event!);
    const parsed = gw.parseWebhook(payload, signature);
    expect(parsed).toEqual(event);
    expect(parsed?.occurredAt).toBeInstanceOf(Date);
  });

  it('accepts a Buffer body', async () => {
    const gw = new FakeGateway();
    await gw.chargeOffSession(charge());
    const { payload, signature } = gw.sign(gw.takeEvents()[0]!);
    expect(gw.parseWebhook(Buffer.from(payload), signature)).not.toBeNull();
  });

  it('rejects a tampered body, a bad signature and a wrong secret', async () => {
    const gw = new FakeGateway();
    await gw.chargeOffSession(charge());
    const { payload, signature } = gw.sign(gw.takeEvents()[0]!);
    expect(() => gw.parseWebhook(payload.replace('4900', '1'), signature)).toThrow(
      InvalidSignatureError,
    );
    expect(() => gw.parseWebhook(payload, 'deadbeef')).toThrow(InvalidSignatureError);
    const other = new FakeGateway({ webhookSecret: 'whsec_other' });
    expect(() => other.parseWebhook(payload, signature)).toThrow(InvalidSignatureError);
  });
});
