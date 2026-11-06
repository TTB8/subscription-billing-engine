import { createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayError, GatewayUnavailableError, InvalidSignatureError } from './errors';
import {
  ChargeResult,
  CheckoutInput,
  GatewayEvent,
  OffSessionChargeInput,
  PaymentGateway,
  PaymentMetadata,
  RefundInput,
  RefundResult,
} from './types';

/** What a payment method does on its next charge. */
export type Outcome = 'ok' | { decline: string };

export interface FakeGatewayOptions {
  webhookSecret?: string;
  now?: () => Date;
}

export interface FakeCharge {
  gatewayRef: string;
  customerRef: string;
  paymentMethodRef: string;
  amountCents: number;
  currency: string;
  status: 'succeeded' | 'failed';
  metadata: PaymentMetadata;
  refundedCents: number;
}

interface Script {
  queue: Outcome[];
  fallback: Outcome;
}

interface Session {
  input: CheckoutInput;
  completed: boolean;
}

/**
 * In-memory PaymentGateway for tests. It mimics the parts of Stripe that
 * billing code depends on: idempotent replays, declines as results rather than
 * exceptions, and signed webhooks.
 *
 * Preset payment methods:
 *   pm_ok                  always succeeds
 *   pm_declined            always declines (card_declined)
 *   pm_insufficient_funds  always declines (insufficient_funds)
 *   pm_fails_after_first   succeeds once, then declines (the "good card that
 *                          fails on renewal" scenario)
 */
export class FakeGateway implements PaymentGateway {
  readonly charges: FakeCharge[] = [];
  readonly refunds: Array<{ refundRef: string; gatewayRef: string; amountCents: number }> = [];

  private readonly webhookSecret: string;
  private readonly now: () => Date;
  private readonly scripts = new Map<string, Script>();
  private readonly sessions = new Map<string, Session>();
  private readonly events: GatewayEvent[] = [];
  private readonly replay = new Map<string, { fingerprint: string; result: unknown }>();
  private sequence = 0;
  private outage = false;
  private loseNextResponse = false;

  constructor(options: FakeGatewayOptions = {}) {
    this.webhookSecret = options.webhookSecret ?? 'whsec_fake';
    this.now = options.now ?? (() => new Date());
    this.script('pm_ok', [], 'ok');
    this.script('pm_declined', [], { decline: 'card_declined' });
    this.script('pm_insufficient_funds', [], { decline: 'insufficient_funds' });
    this.script('pm_fails_after_first', ['ok'], { decline: 'card_declined' });
  }

  // --- test controls ---------------------------------------------------------

  /** Queue outcomes for a payment method; `fallback` applies once the queue is empty. */
  script(paymentMethodRef: string, queue: Outcome[], fallback: Outcome = 'ok'): void {
    this.scripts.set(paymentMethodRef, { queue: [...queue], fallback });
  }

  /** While true, every gateway call throws GatewayUnavailableError (unknown outcome). */
  setOutage(on: boolean): void {
    this.outage = on;
  }

  /**
   * The next off-session charge is executed by the provider, but the response
   * is lost: the caller sees GatewayUnavailableError. Retrying with the same
   * idempotency key must replay that result instead of charging again.
   */
  loseNextChargeResponse(): void {
    this.loseNextResponse = true;
  }

  /** The customer pays the hosted page. Returns the charge result and emits the webhook event. */
  completeCheckout(sessionRef: string, paymentMethodRef: string): ChargeResult {
    const session = this.sessions.get(sessionRef);
    if (!session) throw new GatewayError(`Unknown checkout session ${sessionRef}`);
    if (session.completed)
      throw new GatewayError(`Checkout session ${sessionRef} already completed`);
    session.completed = true;
    const { input } = session;
    return this.runCharge({
      customerRef: input.customerRef,
      paymentMethodRef,
      amountCents: input.amountCents,
      currency: input.currency,
      metadata: input.metadata,
    });
  }

  /** Events the gateway would have sent since the last call. */
  takeEvents(): GatewayEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Serialize an event the way a provider would deliver it: raw body plus signature. */
  sign(event: GatewayEvent): { payload: string; signature: string } {
    const payload = JSON.stringify(event);
    return { payload, signature: this.signature(payload) };
  }

  successfulCharges(): FakeCharge[] {
    return this.charges.filter((c) => c.status === 'succeeded');
  }

  // --- PaymentGateway --------------------------------------------------------

  async ensureCustomer(input: { email: string; idempotencyKey: string }) {
    this.assertAvailable();
    return this.idempotent(input.idempotencyKey, { email: input.email }, () => ({
      customerRef: this.nextId('cus'),
    }));
  }

  async createCheckoutSession(input: CheckoutInput) {
    this.assertAvailable();
    return this.idempotent(input.idempotencyKey, { ...input }, () => {
      const sessionRef = this.nextId('cs');
      this.sessions.set(sessionRef, { input, completed: false });
      return { sessionRef, url: `https://fake.invalid/pay/${sessionRef}` };
    });
  }

  async chargeOffSession(input: OffSessionChargeInput): Promise<ChargeResult> {
    this.assertAvailable();
    const result = this.idempotent(input.idempotencyKey, { ...input }, () => this.runCharge(input));
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new GatewayUnavailableError('Connection reset before the response arrived');
    }
    return result;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.assertAvailable();
    return this.idempotent(input.idempotencyKey, { ...input }, () => {
      const charge = this.charges.find((c) => c.gatewayRef === input.gatewayRef);
      if (!charge || charge.status !== 'succeeded') {
        throw new GatewayError(`No successful charge ${input.gatewayRef} to refund`);
      }
      if (charge.refundedCents + input.amountCents > charge.amountCents) {
        throw new GatewayError('Refund exceeds the amount charged');
      }
      charge.refundedCents += input.amountCents;
      const refundRef = this.nextId('re');
      this.refunds.push({
        refundRef,
        gatewayRef: input.gatewayRef,
        amountCents: input.amountCents,
      });
      return { refundRef, status: 'succeeded' as const };
    });
  }

  parseWebhook(payload: string | Buffer, signature: string): GatewayEvent | null {
    const body = typeof payload === 'string' ? payload : payload.toString('utf8');
    const expected = Buffer.from(this.signature(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new InvalidSignatureError();
    }
    const event = JSON.parse(body) as GatewayEvent & { occurredAt: string };
    return { ...event, occurredAt: new Date(event.occurredAt) };
  }

  // --- internals -------------------------------------------------------------

  private runCharge(input: {
    customerRef: string;
    paymentMethodRef: string;
    amountCents: number;
    currency: string;
    metadata: PaymentMetadata;
  }): ChargeResult {
    const outcome = this.nextOutcome(input.paymentMethodRef);
    const gatewayRef = this.nextId('pi');
    const succeeded = outcome === 'ok';
    this.charges.push({
      gatewayRef,
      customerRef: input.customerRef,
      paymentMethodRef: input.paymentMethodRef,
      amountCents: input.amountCents,
      currency: input.currency,
      status: succeeded ? 'succeeded' : 'failed',
      metadata: input.metadata,
      refundedCents: 0,
    });

    const base = {
      eventId: this.nextId('evt'),
      gatewayRef,
      customerRef: input.customerRef,
      paymentMethodRef: input.paymentMethodRef,
      amountCents: input.amountCents,
      currency: input.currency,
      metadata: input.metadata,
      occurredAt: this.now(),
    };
    if (outcome === 'ok') {
      this.events.push({ ...base, type: 'payment.succeeded' });
      return { status: 'succeeded', gatewayRef };
    }
    this.events.push({ ...base, type: 'payment.failed', failureCode: outcome.decline });
    return { status: 'failed', gatewayRef, failureCode: outcome.decline };
  }

  private nextOutcome(paymentMethodRef: string): Outcome {
    const script = this.scripts.get(paymentMethodRef);
    if (!script) return { decline: 'payment_method_not_found' };
    return script.queue.shift() ?? script.fallback;
  }

  /** Same key + same parameters replays the first result; same key + different parameters is an error. */
  private idempotent<T>(key: string, params: unknown, run: () => T): T {
    const fingerprint = JSON.stringify(params);
    const seen = this.replay.get(key);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new GatewayError(`Idempotency key ${key} was reused with different parameters`);
      }
      return seen.result as T;
    }
    const result = run();
    this.replay.set(key, { fingerprint, result });
    return result;
  }

  private assertAvailable(): void {
    if (this.outage) throw new GatewayUnavailableError('Gateway unreachable');
  }

  private signature(body: string): string {
    return createHmac('sha256', this.webhookSecret).update(body).digest('hex');
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake_${this.sequence}`;
  }
}
