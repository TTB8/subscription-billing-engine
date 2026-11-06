import { addDays } from '../src/cycle';
import { settleFailure, settleSuccess, SubscriptionSnapshot } from '../src/settlement';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const D = utc('2026-02-01'); // the due date of the cycle being paid

const sub = (over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  status: 'active',
  termCycles: 1,
  cycleDays: 28,
  anchorAt: utc('2026-01-04'),
  paidThroughAt: D,
  failureCount: 0,
  dueAt: null,
  pendingStop: null,
  ...over,
});

const pastDue = (failureCount: number, over: Partial<SubscriptionSnapshot> = {}) =>
  sub({ status: 'past_due', failureCount, dueAt: D, ...over });

function applied(decision: ReturnType<typeof settleSuccess>) {
  if (decision.kind !== 'apply') throw new Error(`expected apply, got ${decision.reason}`);
  return decision;
}

describe('settleSuccess', () => {
  it('anchors the cycle to the first payment', () => {
    const paidAt = new Date('2026-01-04T13:45:00.000Z');
    const { patch, period } = applied(
      settleSuccess(sub({ status: 'pending_payment', anchorAt: null, paidThroughAt: null }), {
        paidAt,
      }),
    );
    expect(patch.status).toBe('active');
    expect(patch.anchorAt).toEqual(paidAt);
    expect(period?.start).toEqual(paidAt);
    expect(patch.paidThroughAt).toEqual(addDays(paidAt, 28));
  });

  it('covers the whole prepaid term', () => {
    const { patch } = applied(
      settleSuccess(
        sub({ status: 'pending_payment', anchorAt: null, paidThroughAt: null, termCycles: 3 }),
        {
          paidAt: utc('2026-01-04'),
        },
      ),
    );
    expect(iso(patch.paidThroughAt)).toBe('2026-03-29'); // 84 days
  });

  it('continues the cycle on an on-time renewal and keeps the anchor', () => {
    const { patch, period } = applied(settleSuccess(sub(), { paidAt: D }));
    expect(period?.start).toEqual(D);
    expect(iso(patch.paidThroughAt)).toBe('2026-03-01');
    expect(patch.anchorAt).toEqual(utc('2026-01-04'));
  });

  it('does not shift the cycle when the renewal is paid early', () => {
    const { period } = applied(settleSuccess(sub(), { paidAt: utc('2026-01-28') }));
    expect(period?.start).toEqual(D);
  });

  it('restarts at the payment date when the payment is late, and ends dunning', () => {
    const { patch, period } = applied(
      settleSuccess(pastDue(2, { dueAt: D }), { paidAt: utc('2026-02-05') }),
    );
    expect(period?.start).toEqual(utc('2026-02-05'));
    expect(iso(patch.paidThroughAt)).toBe('2026-03-05'); // not 2026-03-01
    expect(patch).toMatchObject({
      status: 'active',
      failureCount: 0,
      dueAt: null,
      nextRetryAt: null,
    });
    expect(patch.anchorAt).toEqual(utc('2026-01-04'));
  });

  it('resumes a paused subscription from the payment date', () => {
    const { patch } = applied(
      settleSuccess(sub({ status: 'paused' }), { paidAt: utc('2026-02-10') }),
    );
    expect(patch.status).toBe('active');
    expect(iso(patch.paidThroughAt)).toBe('2026-03-10');
  });

  it('keeps a scheduled pause or cancel', () => {
    const { patch } = applied(settleSuccess(sub({ pendingStop: 'cancel' }), { paidAt: D }));
    expect(patch.pendingStop).toBe('cancel');
  });

  it('records money for a canceled subscription without granting coverage', () => {
    expect(settleSuccess(sub({ status: 'canceled' }), { paidAt: D })).toEqual({
      kind: 'record_only',
      reason: 'subscription_canceled',
    });
  });
});

describe('settleFailure', () => {
  const failure = (s: SubscriptionSnapshot, attempt: number, extra = {}) =>
    settleFailure(s, { dueAt: D, attempt, ...extra });

  it('moves an active subscription to past_due and schedules a retry one day after the due date', () => {
    const { patch } = applied(failure(sub(), 1));
    expect(patch).toMatchObject({ status: 'past_due', failureCount: 1, dueAt: D });
    expect(iso(patch.nextRetryAt)).toBe('2026-02-02');
    expect(patch.paidThroughAt).toEqual(D);
  });

  it('schedules later retries from the original due date', () => {
    expect(iso(applied(failure(pastDue(1), 2)).patch.nextRetryAt)).toBe('2026-02-04');
    expect(iso(applied(failure(pastDue(2), 3)).patch.nextRetryAt)).toBe('2026-02-08');
  });

  it('cancels after the final retry fails and clears dunning state', () => {
    const { patch } = applied(failure(pastDue(3, { pendingStop: 'pause' }), 4));
    expect(patch).toMatchObject({
      status: 'canceled',
      failureCount: 0,
      dueAt: null,
      nextRetryAt: null,
      pendingStop: null,
    });
  });

  it('cancels straight away when the schedule has no retries', () => {
    const { patch } = applied(failure(sub(), 1, { schedule: [] }));
    expect(patch.status).toBe('canceled');
  });

  it('handles attempt 2 arriving before attempt 1', () => {
    const { patch } = applied(failure(sub(), 2));
    expect(patch).toMatchObject({ status: 'past_due', failureCount: 2 });
    expect(iso(patch.nextRetryAt)).toBe('2026-02-04');
  });

  it('ignores attempt 1 once attempt 2 is counted, and a repeat of the same attempt', () => {
    expect(failure(pastDue(2), 1)).toEqual({ kind: 'record_only', reason: 'stale' });
    expect(failure(pastDue(2), 2)).toEqual({ kind: 'record_only', reason: 'stale' });
  });

  it('ignores a failure for a period that has since been paid', () => {
    const paidSince = sub({ paidThroughAt: utc('2026-03-01') });
    expect(failure(paidSince, 1)).toEqual({ kind: 'record_only', reason: 'stale' });
  });

  it('ignores a failure for an older due date than the one being dunned', () => {
    const decision = settleFailure(pastDue(1), { dueAt: utc('2026-01-04'), attempt: 2 });
    expect(decision).toEqual({ kind: 'record_only', reason: 'stale' });
  });

  it.each(['pending_payment', 'paused', 'canceled'] as const)(
    'leaves a %s subscription alone',
    (status) => {
      expect(failure(sub({ status }), 1)).toEqual({
        kind: 'record_only',
        reason: 'not_applicable',
      });
    },
  );

  it('treats an active subscription with no paid-through date as due', () => {
    expect(failure(sub({ paidThroughAt: null }), 1).kind).toBe('apply');
  });
});
