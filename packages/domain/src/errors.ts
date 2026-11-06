/**
 * @file Error types for billing rule violations, so callers can tell a bad argument from an
 * illegal state change without parsing messages.
 */

/**
 * Base class for every error the billing rules raise. The API layer maps these to HTTP in one
 * place.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An input is malformed or out of range, such as a fractional cent amount or a zero-length
 * cycle.
 */
export class InvalidArgumentError extends DomainError {}

/** The requested change is not allowed from the subscription's current state. */
export class InvalidTransitionError extends DomainError {}

/** A refund the current ledger state does not allow (already refunded, or more than was paid). */
export class RefundError extends DomainError {}
