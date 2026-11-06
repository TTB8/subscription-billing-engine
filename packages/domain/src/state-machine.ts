/**
 * @file The subscription state machine: the complete table of legal status changes. Anything
 * not in the table throws.
 */

import { InvalidTransitionError } from './errors';

/**
 * Where a subscription is in its life. It stays `pending_payment` until the first payment
 * clears, and `canceled` is final.
 */
export type SubscriptionStatus = 'pending_payment' | 'active' | 'past_due' | 'paused' | 'canceled';

/** Something that happened to a subscription and may change its status. */
export type SubscriptionEvent =
  'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'PAUSE' | 'CANCEL' | 'RETRIES_EXHAUSTED';

/**
 * The complete set of legal transitions. Anything not listed throws.
 *
 *   pending_payment -> active          first payment clears (anchors the cycle)
 *   pending_payment -> pending_payment first payment fails; checkout can be retried
 *   pending_payment -> canceled        checkout abandoned
 *   active          -> active          renewal paid
 *   active          -> past_due        renewal failed, dunning starts
 *   active          -> paused | canceled
 *   past_due        -> active          a retry succeeded (cycle restarts at payment date)
 *   past_due        -> past_due        a retry failed, another is scheduled
 *   past_due        -> canceled        retries exhausted, or cancelled by request
 *   past_due        -> paused          nothing is paid forward, so pause applies at once
 *   paused          -> active          resumed by paying (cycle restarts at payment date)
 *   paused          -> canceled
 *   canceled        -> (terminal)
 */
const TRANSITIONS: Record<
  SubscriptionStatus,
  Partial<Record<SubscriptionEvent, SubscriptionStatus>>
> = {
  pending_payment: {
    PAYMENT_SUCCEEDED: 'active',
    PAYMENT_FAILED: 'pending_payment',
    CANCEL: 'canceled',
  },
  active: {
    PAYMENT_SUCCEEDED: 'active',
    PAYMENT_FAILED: 'past_due',
    PAUSE: 'paused',
    CANCEL: 'canceled',
  },
  past_due: {
    PAYMENT_SUCCEEDED: 'active',
    PAYMENT_FAILED: 'past_due',
    RETRIES_EXHAUSTED: 'canceled',
    PAUSE: 'paused',
    CANCEL: 'canceled',
  },
  paused: {
    PAYMENT_SUCCEEDED: 'active',
    CANCEL: 'canceled',
  },
  canceled: {},
};

/** Whether `event` is legal in status `from`, without applying it. */
export function canTransition(from: SubscriptionStatus, event: SubscriptionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/**
 * Applies `event` to `from` and returns the new status. Throws InvalidTransitionError if the
 * table does not allow it.
 */
export function transition(from: SubscriptionStatus, event: SubscriptionEvent): SubscriptionStatus {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new InvalidTransitionError(`Cannot apply ${event} to a ${from} subscription`);
  }
  return to;
}

/** True for a status that nothing can leave (only `canceled`). */
export function isTerminal(status: SubscriptionStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}
