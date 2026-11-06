/**
 * @file Refund rules: how much a refund request refunds, and when it must be refused.
 */

import { InvalidArgumentError, RefundError } from './errors';
import { assertCents, Cents } from './money';

/**
 * How much a refund request actually refunds.
 *
 * - No amount requested: refund everything still refundable.
 * - An amount: it must be at least 1 cent and no more than what remains.
 * - A charge that is already fully refunded cannot be refunded again.
 *
 * Refunds are an explicit admin action. Cancelling a subscription never
 * triggers one: the customer keeps the cycle they paid for.
 */
export function resolveRefund(input: {
  chargedCents: Cents;
  refundedCents: Cents;
  requestedCents?: number;
}): Cents {
  const { chargedCents, refundedCents, requestedCents } = input;
  assertCents(chargedCents, 'chargedCents');
  assertCents(refundedCents, 'refundedCents');
  if (refundedCents > chargedCents) {
    throw new InvalidArgumentError(
      'refundedCents exceeds chargedCents: the ledger is inconsistent',
    );
  }

  const remaining = chargedCents - refundedCents;
  if (remaining === 0) {
    throw new RefundError('This charge is already fully refunded');
  }
  if (requestedCents === undefined) {
    return remaining;
  }
  if (!Number.isInteger(requestedCents) || requestedCents < 1) {
    throw new InvalidArgumentError('Refund amount must be a whole number of cents, at least 1');
  }
  if (requestedCents > remaining) {
    throw new RefundError(`Cannot refund ${requestedCents}: only ${remaining} remains refundable`);
  }
  return requestedCents;
}
