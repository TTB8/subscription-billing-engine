import { InvalidTransitionError } from './errors';
import { SubscriptionStatus } from './state-machine';

export type StopKind = 'pause' | 'cancel';

export type StopResolution =
  { effect: 'immediate' } | { effect: 'at_period_end'; effectiveAt: Date };

/**
 * When a pause or cancel request takes effect.
 *
 * - Active with coverage remaining: at the end of the paid period. The
 *   customer keeps what they paid for and nothing is refunded.
 * - Nothing paid forward (pending, past_due, or coverage already lapsed):
 *   immediately.
 * - Cancel overrides a pending pause; pause cannot override a pending cancel.
 *
 * There is no proration and no mid-term refund: the cycle is the unit of sale.
 */
export function resolveStop(input: {
  kind: StopKind;
  status: SubscriptionStatus;
  now: Date;
  paidThrough: Date | null;
  pendingStop: StopKind | null;
}): StopResolution {
  const { kind, status, now, paidThrough, pendingStop } = input;

  if (status === 'canceled') {
    throw new InvalidTransitionError(`Cannot ${kind} a canceled subscription`);
  }
  if (kind === 'pause' && status === 'paused') {
    throw new InvalidTransitionError('Subscription is already paused');
  }
  if (kind === 'pause' && status === 'pending_payment') {
    throw new InvalidTransitionError('Cannot pause a subscription that has not been paid');
  }
  if (kind === 'pause' && pendingStop === 'cancel') {
    throw new InvalidTransitionError('Cancellation is already scheduled');
  }

  const hasCoverage = status === 'active' && paidThrough !== null && paidThrough > now;
  return hasCoverage
    ? { effect: 'at_period_end', effectiveAt: paidThrough }
    : { effect: 'immediate' };
}

export type RenewalDecision = 'not_due' | 'charge' | 'pause' | 'cancel';

/**
 * What the renewal job should do with a subscription right now.
 * Only active subscriptions renew here; past_due ones belong to dunning.
 * A scheduled pause or cancel is applied instead of charging.
 */
export function decideRenewal(input: {
  status: SubscriptionStatus;
  paidThrough: Date | null;
  now: Date;
  pendingStop: StopKind | null;
}): RenewalDecision {
  const { status, paidThrough, now, pendingStop } = input;
  if (status !== 'active' || paidThrough === null || now < paidThrough) {
    return 'not_due';
  }
  return pendingStop ?? 'charge';
}
