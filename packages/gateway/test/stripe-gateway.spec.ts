import Stripe from 'stripe';
import {
  GatewayError,
  GatewayUnavailableError,
  InvalidSignatureError,
  PaymentMetadata,
  StripeGateway,
} from '../src';

const WEBHOOK_SECRET = 'whsec_test_secret';

const metadata: PaymentMetadata = {
  subscriptionId: 'sub_1',
  periodStart: '2025-01-01T00:00:00.000Z',
  attempt: 2,
};

function setup() {
  const client = new Stripe('sk_test_not_a_real_key');
  const gateway = new StripeGateway({
    secretKey: 'sk_test_not_a_real_key',
    webhookSecret: WEBHOOK_SECRET,
    client,
  });
  return { client, gateway };
}

const mock = (fn: unknown) => fn as jest.Mock;
const resolved = (client: Stripe, resource: 'paymentIntents' | 'refunds', value: unknown) =>
  jest.spyOn(client[resource], 'create').mockResolvedValue(value as never);
const rejected = (client: Stripe, error: unknown) =>
  jest.spyOn(client.paymentIntents, 'create').mockRejectedValue(error as never);

const chargeInput = {
  customerRef: 'cus_1',
  paymentMethodRef: 'pm_1',
  amountCents: 4900,
  currency: 'usd',
  description: 'Standard, 4 weeks',
  metadata,
  idempotencyKey: 'sub_1:2025-01-01:2',
};

describe('StripeGateway.chargeOffSession', () => {
  it('creates an off-session, confirmed PaymentIntent with the idempotency key', async () => {
    const { client, gateway } = setup();
    const create = resolved(client, 'paymentIntents', { id: 'pi_1', status: 'succeeded' });
    await expect(gateway.chargeOffSession(chargeInput)).resolves.toEqual({
      status: 'succeeded',
      gatewayRef: 'pi_1',
    });
    const [params, options] = mock(create).mock.calls[0];
    expect(params).toMatchObject({
      amount: 4900,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: true,
      confirm: true,
      metadata: { subscriptionId: 'sub_1', periodStart: '2025-01-01T00:00:00.000Z', attempt: '2' },
    });
    expect(options).toEqual({ idempotencyKey: 'sub_1:2025-01-01:2' });
  });

  it('maps a card decline to a failed result using the decline code', async () => {
    const { client, gateway } = setup();
    rejected(
      client,
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'Your card has insufficient funds.',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        payment_intent: { id: 'pi_failed' },
      } as never),
    );
    await expect(gateway.chargeOffSession(chargeInput)).resolves.toEqual({
      status: 'failed',
      gatewayRef: 'pi_failed',
      failureCode: 'insufficient_funds',
    });
  });

  it('falls back to the error code, then to card_declined', async () => {
    const { client, gateway } = setup();
    rejected(
      client,
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        message: 'x',
        code: 'expired_card',
      } as never),
    );
    await expect(gateway.chargeOffSession(chargeInput)).resolves.toMatchObject({
      failureCode: 'expired_card',
      gatewayRef: null,
    });
    rejected(
      client,
      new Stripe.errors.StripeCardError({ type: 'card_error', message: 'x' } as never),
    );
    await expect(gateway.chargeOffSession(chargeInput)).resolves.toMatchObject({
      failureCode: 'card_declined',
    });
  });

  it('treats a PaymentIntent that needs customer action as a failure', async () => {
    const { client, gateway } = setup();
    resolved(client, 'paymentIntents', { id: 'pi_sca', status: 'requires_action' });
    await expect(gateway.chargeOffSession(chargeInput)).resolves.toEqual({
      status: 'failed',
      gatewayRef: 'pi_sca',
      failureCode: 'authentication_required',
    });
  });

  it.each([
    [
      'connection',
      new Stripe.errors.StripeConnectionError({
        type: 'api_connection_error',
        message: 'down',
      } as never),
    ],
    ['api', new Stripe.errors.StripeAPIError({ type: 'api_error', message: '500' } as never)],
    [
      'rate limit',
      new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: '429' } as never),
    ],
  ])('throws GatewayUnavailableError on a %s error (outcome unknown)', async (_name, error) => {
    const { client, gateway } = setup();
    rejected(client, error);
    await expect(gateway.chargeOffSession(chargeInput)).rejects.toThrow(GatewayUnavailableError);
  });

  it('throws a plain GatewayError on configuration or programming errors', async () => {
    const { client, gateway } = setup();
    rejected(
      client,
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'bad',
      } as never),
    );
    const failure = gateway.chargeOffSession(chargeInput);
    await expect(failure).rejects.toThrow(GatewayError);
    await expect(failure).rejects.not.toThrow(GatewayUnavailableError);
    rejected(client, 'not an Error');
    await expect(gateway.chargeOffSession(chargeInput)).rejects.toThrow('Unknown gateway error');
  });
});

describe('StripeGateway other calls', () => {
  it('creates a customer with an idempotency key', async () => {
    const { client, gateway } = setup();
    const create = jest
      .spyOn(client.customers, 'create')
      .mockResolvedValue({ id: 'cus_9' } as never);
    await expect(
      gateway.ensureCustomer({ email: 'a@example.test', idempotencyKey: 'cust:1' }),
    ).resolves.toEqual({
      customerRef: 'cus_9',
    });
    expect(mock(create).mock.calls[0]).toEqual([
      { email: 'a@example.test' },
      { idempotencyKey: 'cust:1' },
    ]);
  });

  it('creates a Checkout Session that saves the card for off-session use', async () => {
    const { client, gateway } = setup();
    const create = jest
      .spyOn(client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_1', url: 'https://checkout.example/cs_1' } as never);
    const result = await gateway.createCheckoutSession({
      customerRef: 'cus_1',
      amountCents: 13_230,
      currency: 'usd',
      description: 'Standard, 12 weeks',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
      metadata,
      idempotencyKey: 'checkout:sub_1',
    });
    expect(result).toEqual({ sessionRef: 'cs_1', url: 'https://checkout.example/cs_1' });
    const [params, options] = mock(create).mock.calls[0];
    expect(params).toMatchObject({
      mode: 'payment',
      customer: 'cus_1',
      payment_intent_data: { setup_future_usage: 'off_session' },
    });
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 13_230, currency: 'usd' });
    expect(options).toEqual({ idempotencyKey: 'checkout:sub_1' });
  });

  it('fails if Stripe returns a session without a URL', async () => {
    const { client, gateway } = setup();
    jest
      .spyOn(client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_1', url: null } as never);
    await expect(
      gateway.createCheckoutSession({
        customerRef: 'c',
        amountCents: 1,
        currency: 'usd',
        description: 'x',
        successUrl: 'https://example.test/ok',
        cancelUrl: 'https://example.test/cancel',
        metadata,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('without a URL');
  });

  it.each([
    ['succeeded', 'succeeded'],
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
  ])('maps refund status %s to %s', async (stripeStatus, expected) => {
    const { client, gateway } = setup();
    const create = resolved(client, 'refunds', { id: 're_1', status: stripeStatus });
    await expect(
      gateway.refund({ gatewayRef: 'pi_1', amountCents: 500, idempotencyKey: 'r1' }),
    ).resolves.toEqual({ refundRef: 're_1', status: expected });
    expect(mock(create).mock.calls[0]).toEqual([
      { payment_intent: 'pi_1', amount: 500 },
      { idempotencyKey: 'r1' },
    ]);
  });
});

describe('StripeGateway error handling outside charges', () => {
  it('reports an unreachable Stripe during a refund as an unknown outcome', async () => {
    const { client, gateway } = setup();
    jest.spyOn(client.refunds, 'create').mockRejectedValue(
      new Stripe.errors.StripeConnectionError({
        type: 'api_connection_error',
        message: 'down',
      } as never),
    );
    await expect(
      gateway.refund({ gatewayRef: 'pi_1', amountCents: 500, idempotencyKey: 'r1' }),
    ).rejects.toThrow(GatewayUnavailableError);
  });

  it('reports a rejected customer request as a plain gateway error', async () => {
    const { client, gateway } = setup();
    jest.spyOn(client.customers, 'create').mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'bad email',
      } as never),
    );
    const failure = gateway.ensureCustomer({ email: 'nope', idempotencyKey: 'c1' });
    await expect(failure).rejects.toThrow('bad email');
    await expect(failure).rejects.not.toThrow(GatewayUnavailableError);
  });
});

describe('StripeGateway.parseWebhook', () => {
  const body = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type,
      created: 1_735_689_600,
      data: { object: { object: 'payment_intent', ...object } },
    });

  const sign = (client: Stripe, payload: string, secret = WEBHOOK_SECRET) =>
    client.webhooks.generateTestHeaderString({ payload, secret });

  const intent = {
    id: 'pi_1',
    amount: 4900,
    currency: 'usd',
    customer: 'cus_1',
    payment_method: 'pm_1',
    metadata: { subscriptionId: 'sub_1', periodStart: '2025-01-01T00:00:00.000Z', attempt: '2' },
  };

  it('normalizes payment_intent.succeeded', () => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.succeeded', intent);
    expect(gateway.parseWebhook(payload, sign(client, payload))).toEqual({
      type: 'payment.succeeded',
      eventId: 'evt_1',
      gatewayRef: 'pi_1',
      customerRef: 'cus_1',
      paymentMethodRef: 'pm_1',
      amountCents: 4900,
      currency: 'usd',
      metadata,
      occurredAt: new Date('2025-01-01T00:00:00.000Z'),
    });
  });

  it('normalizes payment_intent.payment_failed with the decline code', () => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.payment_failed', {
      ...intent,
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
    });
    expect(gateway.parseWebhook(payload, sign(client, payload))).toMatchObject({
      type: 'payment.failed',
      failureCode: 'insufficient_funds',
    });
  });

  it('falls back to the error code, then to a generic failure code', () => {
    const { client, gateway } = setup();
    const withCode = body('payment_intent.payment_failed', {
      ...intent,
      last_payment_error: { code: 'expired_card' },
    });
    expect(gateway.parseWebhook(withCode, sign(client, withCode))).toMatchObject({
      failureCode: 'expired_card',
    });
    const bare = body('payment_intent.payment_failed', intent);
    expect(gateway.parseWebhook(bare, sign(client, bare))).toMatchObject({
      failureCode: 'payment_failed',
    });
  });

  it('treats an empty decline_code as absent', () => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.payment_failed', {
      ...intent,
      last_payment_error: { code: 'incorrect_cvc', decline_code: '' },
    });
    expect(gateway.parseWebhook(payload, sign(client, payload))).toMatchObject({
      failureCode: 'incorrect_cvc',
    });
  });

  it('expands customer and payment method objects to ids, and tolerates nulls', () => {
    const { client, gateway } = setup();
    const expanded = body('payment_intent.succeeded', {
      ...intent,
      customer: { id: 'cus_obj' },
      payment_method: { id: 'pm_obj' },
    });
    expect(gateway.parseWebhook(expanded, sign(client, expanded))).toMatchObject({
      customerRef: 'cus_obj',
      paymentMethodRef: 'pm_obj',
    });
    const nulls = body('payment_intent.succeeded', {
      ...intent,
      customer: null,
      payment_method: null,
    });
    expect(gateway.parseWebhook(nulls, sign(client, nulls))).toMatchObject({
      customerRef: null,
      paymentMethodRef: null,
    });
  });

  it.each([
    ['missing metadata', {}],
    ['incomplete metadata', { subscriptionId: 'sub_1' }],
    ['non-numeric attempt', { subscriptionId: 'sub_1', periodStart: '2025-01-01', attempt: 'x' }],
    ['attempt below 1', { subscriptionId: 'sub_1', periodStart: '2025-01-01', attempt: '0' }],
  ])('returns null metadata for %s', (_name, md) => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.succeeded', { ...intent, metadata: md });
    expect(gateway.parseWebhook(payload, sign(client, payload))).toMatchObject({ metadata: null });
  });

  it('ignores event types it does not handle', () => {
    const { client, gateway } = setup();
    const payload = body('customer.created', {});
    expect(gateway.parseWebhook(payload, sign(client, payload))).toBeNull();
  });

  it('rejects a wrong secret, a tampered body and a missing signature', () => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.succeeded', intent);
    expect(() => gateway.parseWebhook(payload, sign(client, payload, 'whsec_other'))).toThrow(
      InvalidSignatureError,
    );
    expect(() => gateway.parseWebhook(payload.replace('4900', '1'), sign(client, payload))).toThrow(
      InvalidSignatureError,
    );
    expect(() => gateway.parseWebhook(payload, '')).toThrow(InvalidSignatureError);
  });

  it('verifies a Buffer body', () => {
    const { client, gateway } = setup();
    const payload = body('payment_intent.succeeded', intent);
    expect(gateway.parseWebhook(Buffer.from(payload), sign(client, payload))).not.toBeNull();
  });
});
