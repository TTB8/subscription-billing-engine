/**
 * @file The payment provider contract. Billing code depends only on these types, so the
 * provider can be swapped or faked without touching it.
 */

/** Money is an integer number of minor units (cents). */
export type Cents = number;

/** Carried on every payment so a webhook can be matched back to a billing period. */
export interface PaymentMetadata {
  subscriptionId: string;
  /** ISO-8601 UTC start of the period being paid for. */
  periodStart: string;
  /** 1 for the renewal itself, 2.. for dunning retries. */
  attempt: number;
}

/** Everything needed to start a hosted first payment that also saves the card for later. */
export interface CheckoutInput {
  customerRef: string;
  amountCents: Cents;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: PaymentMetadata;
  idempotencyKey: string;
}

/** A charge made while the customer is not present, using a card saved earlier. */
export interface OffSessionChargeInput {
  customerRef: string;
  paymentMethodRef: string;
  amountCents: Cents;
  currency: string;
  description: string;
  metadata: PaymentMetadata;
  idempotencyKey: string;
}

/**
 * A declined card is a normal result, not an exception. An exception means the
 * outcome is UNKNOWN (network, outage): the caller must retry with the SAME
 * idempotency key and must not count it as a failed payment.
 */
export type ChargeResult =
  | { status: 'succeeded'; gatewayRef: string }
  | { status: 'failed'; gatewayRef: string | null; failureCode: string };

/** A refund of part or all of one charge. */
export interface RefundInput {
  /** The gatewayRef of the charge being refunded. */
  gatewayRef: string;
  amountCents: Cents;
  idempotencyKey: string;
}

/**
 * What the provider did with a refund request. `pending` means accepted and still completing.
 */
export interface RefundResult {
  refundRef: string;
  status: 'succeeded' | 'pending' | 'failed';
}

interface BaseEvent {
  /** Unique per provider event; used to deduplicate redelivery. */
  eventId: string;
  gatewayRef: string;
  customerRef: string | null;
  paymentMethodRef: string | null;
  amountCents: Cents;
  currency: string;
  /** Null when the payment was not created by this system. */
  metadata: PaymentMetadata | null;
  occurredAt: Date;
}

/** A payment cleared at the provider. */
export interface PaymentSucceededEvent extends BaseEvent {
  type: 'payment.succeeded';
}

/** A payment was declined or failed at the provider. */
export interface PaymentFailedEvent extends BaseEvent {
  type: 'payment.failed';
  failureCode: string;
}

/** The provider events this system handles, in a provider-neutral shape. */
export type GatewayEvent = PaymentSucceededEvent | PaymentFailedEvent;

/**
 * The operations billing needs from a payment provider. StripeGateway implements it for
 * production and FakeGateway for tests.
 */
export interface PaymentGateway {
  ensureCustomer(input: {
    email: string;
    idempotencyKey: string;
  }): Promise<{ customerRef: string }>;

  /** Hosted first payment. The card is saved for off-session renewals. */
  createCheckoutSession(input: CheckoutInput): Promise<{ sessionRef: string; url: string }>;

  chargeOffSession(input: OffSessionChargeInput): Promise<ChargeResult>;

  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Verifies the signature over the RAW request body and returns a normalized
   * event, or null for event types this system does not handle.
   * Throws InvalidSignatureError if verification fails.
   */
  parseWebhook(payload: string | Buffer, signature: string): GatewayEvent | null;
}
