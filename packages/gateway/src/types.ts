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

export interface RefundInput {
  /** The gatewayRef of the charge being refunded. */
  gatewayRef: string;
  amountCents: Cents;
  idempotencyKey: string;
}

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

export interface PaymentSucceededEvent extends BaseEvent {
  type: 'payment.succeeded';
}

export interface PaymentFailedEvent extends BaseEvent {
  type: 'payment.failed';
  failureCode: string;
}

export type GatewayEvent = PaymentSucceededEvent | PaymentFailedEvent;

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
