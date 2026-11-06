/**
 * @file Idempotency key derivation. Keys are derived from what is being paid for, never from
 * a clock or a random value, so a retry of the same operation always produces
 * the same key and the provider replays instead of repeating.
 */

/** One key per (subscription, due date, attempt): the renewal itself is attempt 1. */
export function chargeIdempotencyKey(
  subscriptionId: string,
  periodStartIso: string,
  attempt: number,
): string {
  return `charge:${subscriptionId}:${periodStartIso}:${attempt}`;
}

/** `sequence` is this refund's position among the refunds of the charge, starting at 1. */
export function refundIdempotencyKey(chargeId: string, sequence: number): string {
  return `refund:${chargeId}:${sequence}`;
}
