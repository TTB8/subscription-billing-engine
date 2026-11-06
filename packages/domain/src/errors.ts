export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidArgumentError extends DomainError {}

export class InvalidTransitionError extends DomainError {}

/** A refund the current ledger state does not allow (already refunded, or more than was paid). */
export class RefundError extends DomainError {}
