/**
 * @file Settlement: turning a payment result into a subscription change. Pure decisions only;
 * the API layer does the reading and writing.
 */

import { Period, periodForPayment } from './cycle';
import { DEFAULT_RETRY_SCHEDULE_DAYS, nextDunningAction } from './dunning';
import { StopKind } from './lifecycle';
import { SubscriptionStatus, transition } from './state-machine';

/** The fields of a subscription that settlement reads. */
export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  termCycles: number;
  cycleDays: number;
  anchorAt: Date | null;
  paidThroughAt: Date | null;
  failureCount: number;
  dueAt: Date | null;
  pendingStop: StopKind | null;
}

/** The fields settlement may change. The caller writes all of them. */
export interface SubscriptionPatch {
  status: SubscriptionStatus;
  anchorAt: Date | null;
  paidThroughAt: Date | null;
  failureCount: number;
  dueAt: Date | null;
  nextRetryAt: Date | null;
  pendingStop: StopKind | null;
}

/** Why a payment was written to the ledger without changing the subscription. */
export type RecordOnlyReason =
  /** Money moved for a subscription that is already canceled: the ledger records it, coverage is not granted. */
  | 'subscription_canceled'
  /** The event is about a period or attempt that has already been dealt with. */
  | 'stale'
  /** The failure does not affect this status (an unpaid checkout, a paused or canceled subscription). */
  | 'not_applicable';

/**
 * Either change the subscription, or leave it alone. The payment is written to
 * the ledger in both cases: the ledger records what happened at the provider,
 * the subscription records what that means for the customer.
 */
export type SettlementDecision =
  | { kind: 'apply'; patch: SubscriptionPatch; period: Period | null }
  | { kind: 'record_only'; reason: RecordOnlyReason };

/**
 * A payment cleared.
 *
 * The covered period comes from the payment date and the current paid-through
 * date (see periodForPayment): first payment anchors the cycle, on-time or
 * early renewals continue it, late payments and resumes restart it at the
 * payment date. A successful payment ends any dunning.
 */
export function settleSuccess(
  sub: SubscriptionSnapshot,
  input: { paidAt: Date },
): SettlementDecision {
  if (sub.status === 'canceled') {
    return { kind: 'record_only', reason: 'subscription_canceled' };
  }

  const status = transition(sub.status, 'PAYMENT_SUCCEEDED');
  const period = periodForPayment({
    paidAt: input.paidAt,
    paidThrough: sub.paidThroughAt,
    cycleDays: sub.cycleDays,
    cycles: sub.termCycles,
  });

  return {
    kind: 'apply',
    period,
    patch: {
      status,
      anchorAt: sub.anchorAt ?? period.start,
      paidThroughAt: period.end,
      failureCount: 0,
      dueAt: null,
      nextRetryAt: null,
      pendingStop: sub.pendingStop,
    },
  };
}

/**
 * A charge failed.
 *
 * The state is derived from the attempt number and the due date carried by the
 * event, never from how many events happened to arrive, so duplicates and
 * out-of-order delivery cannot push a subscription backwards:
 *  - a failure for a period that has since been paid is stale;
 *  - a failure for an attempt that is already counted is stale;
 *  - a failure for an older due date than the one being dunned is stale.
 */
export function settleFailure(
  sub: SubscriptionSnapshot,
  input: { dueAt: Date; attempt: number; schedule?: readonly number[] },
): SettlementDecision {
  const { dueAt, attempt, schedule = DEFAULT_RETRY_SCHEDULE_DAYS } = input;

  if (sub.status !== 'active' && sub.status !== 'past_due') {
    return { kind: 'record_only', reason: 'not_applicable' };
  }
  if (sub.status === 'active' && sub.paidThroughAt !== null && sub.paidThroughAt > dueAt) {
    return { kind: 'record_only', reason: 'stale' };
  }
  if (sub.status === 'past_due') {
    const sameDue = sub.dueAt !== null && sub.dueAt.getTime() === dueAt.getTime();
    if (!sameDue || attempt <= sub.failureCount) {
      return { kind: 'record_only', reason: 'stale' };
    }
  }

  const action = nextDunningAction({ dueAt, failureCount: attempt, schedule });
  const pastDue = transition(sub.status, 'PAYMENT_FAILED');

  if (action.type === 'retry') {
    return {
      kind: 'apply',
      period: null,
      patch: {
        status: pastDue,
        anchorAt: sub.anchorAt,
        paidThroughAt: sub.paidThroughAt,
        failureCount: attempt,
        dueAt,
        nextRetryAt: action.at,
        pendingStop: sub.pendingStop,
      },
    };
  }

  return {
    kind: 'apply',
    period: null,
    patch: {
      status: transition(pastDue, 'RETRIES_EXHAUSTED'),
      anchorAt: sub.anchorAt,
      paidThroughAt: sub.paidThroughAt,
      failureCount: 0,
      dueAt: null,
      nextRetryAt: null,
      pendingStop: null,
    },
  };
}
