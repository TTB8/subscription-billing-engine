export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The outcome of the call is unknown. Retry with the same idempotency key. */
export class GatewayUnavailableError extends GatewayError {}

export class InvalidSignatureError extends GatewayError {
  constructor() {
    super('Webhook signature verification failed');
  }
}
