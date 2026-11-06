/**
 * @file PaymentGateway backed by Stripe. Maps Stripe's API and webhook events onto the
 * provider-neutral contract, and sorts Stripe errors into a declined card, an unknown outcome,
 * or a rejected request.
 */

import Stripe from 'stripe';
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

/** Settings for StripeGateway. Use a test-mode secret key. */
export interface StripeGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  /** Injected in tests. */
  client?: Stripe;
}

function refId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function readMetadata(raw: Record<string, string> | null | undefined): PaymentMetadata | null {
  const subscriptionId = raw?.subscriptionId;
  const periodStart = raw?.periodStart;
  const attempt = Number(raw?.attempt);
  if (!subscriptionId || !periodStart || !Number.isInteger(attempt) || attempt < 1) {
    return null;
  }
  return { subscriptionId, periodStart, attempt };
}

function toStripeMetadata(metadata: PaymentMetadata): Record<string, string> {
  return {
    subscriptionId: metadata.subscriptionId,
    periodStart: metadata.periodStart,
    attempt: String(metadata.attempt),
  };
}

/**
 * Production payment gateway using the Stripe API. Every mutating call carries an idempotency
 * key.
 */
export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(options: StripeGatewayOptions) {
    this.stripe = options.client ?? new Stripe(options.secretKey);
    this.webhookSecret = options.webhookSecret;
  }

  async ensureCustomer(input: { email: string; idempotencyKey: string }) {
    const customer = await this.call(() =>
      this.stripe.customers.create(
        { email: input.email },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return { customerRef: customer.id };
  }

  async createCheckoutSession(input: CheckoutInput) {
    const metadata = toStripeMetadata(input.metadata);
    const session = await this.call(() =>
      this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          customer: input.customerRef,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amountCents,
                product_data: { name: input.description },
              },
            },
          ],
          // Saves the card so renewals can be charged off-session.
          payment_intent_data: { setup_future_usage: 'off_session', metadata },
          metadata,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    if (!session.url) {
      throw new GatewayError('Stripe returned a Checkout Session without a URL');
    }
    return { sessionRef: session.id, url: session.url };
  }

  async chargeOffSession(input: OffSessionChargeInput): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency,
          customer: input.customerRef,
          payment_method: input.paymentMethodRef,
          description: input.description,
          off_session: true,
          confirm: true,
          metadata: toStripeMetadata(input.metadata),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (intent.status === 'succeeded') {
        return { status: 'succeeded', gatewayRef: intent.id };
      }
      // e.g. requires_action: the customer is not present to authenticate.
      return { status: 'failed', gatewayRef: intent.id, failureCode: 'authentication_required' };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        return {
          status: 'failed',
          gatewayRef: refId(error.payment_intent ?? null),
          // The SDK defaults decline_code to '' when Stripe omits it, so `||` not `??`.
          failureCode: error.decline_code || error.code || 'card_declined',
        };
      }
      throw this.classify(error);
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.call(() =>
      this.stripe.refunds.create(
        { payment_intent: input.gatewayRef, amount: input.amountCents },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    const status =
      refund.status === 'succeeded'
        ? 'succeeded'
        : refund.status === 'pending'
          ? 'pending'
          : 'failed';
    return { refundRef: refund.id, status };
  }

  parseWebhook(payload: string | Buffer, signature: string): GatewayEvent | null {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    } catch {
      throw new InvalidSignatureError();
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      return {
        type: 'payment.succeeded',
        eventId: event.id,
        gatewayRef: intent.id,
        customerRef: refId(intent.customer),
        paymentMethodRef: refId(intent.payment_method),
        amountCents: intent.amount,
        currency: intent.currency,
        metadata: readMetadata(intent.metadata),
        occurredAt: new Date(event.created * 1000),
      };
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object;
      const error = intent.last_payment_error;
      return {
        type: 'payment.failed',
        eventId: event.id,
        gatewayRef: intent.id,
        customerRef: refId(intent.customer),
        paymentMethodRef: refId(intent.payment_method),
        amountCents: intent.amount,
        currency: intent.currency,
        metadata: readMetadata(intent.metadata),
        occurredAt: new Date(event.created * 1000),
        failureCode: error?.decline_code || error?.code || 'payment_failed',
      };
    }

    return null;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** Network and 5xx style failures leave the outcome unknown; the rest are bugs or config. */
  private classify(error: unknown): GatewayError {
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError
    ) {
      return new GatewayUnavailableError(error.message);
    }
    return new GatewayError(error instanceof Error ? error.message : 'Unknown gateway error');
  }
}
