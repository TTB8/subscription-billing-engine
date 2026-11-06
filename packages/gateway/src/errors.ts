/**
 * @file Errors a payment provider can raise, sorted by what the caller should do about them.
 */

/**
 * Base class for payment provider errors. On its own it means the request was rejected: a bug
 * or a configuration problem, not a declined card.
 */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The outcome of the call is unknown. Retry with the same idempotency key. */
export class GatewayUnavailableError extends GatewayError {}

/**
 * A webhook whose signature does not match: forged, tampered with, or signed with a different
 * secret.
 */
export class InvalidSignatureError extends GatewayError {
  constructor() {
    super('Webhook signature verification failed');
  }
}
