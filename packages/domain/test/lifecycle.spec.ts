import { InvalidTransitionError } from '../src/errors';
import { decideRenewal, resolveStop } from '../src/lifecycle';

const now = new Date('2025-06-10T00:00:00.000Z');
const future = new Date('2025-06-20T00:00:00.000Z');
const past = new Date('2025-06-01T00:00:00.000Z');

const stop = (over: Partial<Parameters<typeof resolveStop>[0]> = {}) =>
  resolveStop({
    kind: 'cancel',
    status: 'active',
    now,
    paidThrough: future,
    pendingStop: null,
    ...over,
  });

describe('resolveStop', () => {
  it.each(['cancel', 'pause'] as const)('%s waits for the end of the paid cycle', (kind) => {
    expect(stop({ kind })).toEqual({ effect: 'at_period_end', effectiveAt: future });
  });

  it('applies immediately when coverage has lapsed', () => {
    expect(stop({ paidThrough: past })).toEqual({ effect: 'immediate' });
  });

  it('applies immediately when coverage ends exactly now', () => {
    expect(stop({ paidThrough: now })).toEqual({ effect: 'immediate' });
  });

  it('applies immediately while past_due, even for a pause', () => {
    expect(stop({ kind: 'pause', status: 'past_due', paidThrough: past })).toEqual({
      effect: 'immediate',
    });
    expect(stop({ kind: 'cancel', status: 'past_due', paidThrough: past })).toEqual({
      effect: 'immediate',
    });
  });

  it('cancels an unpaid pending_payment subscription immediately', () => {
    expect(stop({ status: 'pending_payment', paidThrough: null })).toEqual({ effect: 'immediate' });
  });

  it('cancels a paused subscription immediately', () => {
    expect(stop({ status: 'paused', paidThrough: future })).toEqual({ effect: 'immediate' });
  });

  it('lets cancel override a pending pause', () => {
    expect(stop({ pendingStop: 'pause' })).toMatchObject({ effect: 'at_period_end' });
  });

  it.each([
    ['cancel', 'canceled'],
    ['pause', 'canceled'],
    ['pause', 'paused'],
    ['pause', 'pending_payment'],
  ] as const)('rejects %s on a %s subscription', (kind, status) => {
    expect(() => stop({ kind, status })).toThrow(InvalidTransitionError);
  });

  it('rejects a pause while a cancellation is scheduled', () => {
    expect(() => stop({ kind: 'pause', pendingStop: 'cancel' })).toThrow(InvalidTransitionError);
  });
});

describe('decideRenewal', () => {
  const decide = (over: Partial<Parameters<typeof decideRenewal>[0]> = {}) =>
    decideRenewal({ status: 'active', paidThrough: past, now, pendingStop: null, ...over });

  it('charges an active subscription whose coverage has ended', () => {
    expect(decide()).toBe('charge');
  });

  it('is due exactly at the end of coverage', () => {
    expect(decide({ paidThrough: now })).toBe('charge');
  });

  it('does nothing while coverage remains', () => {
    expect(decide({ paidThrough: future })).toBe('not_due');
  });

  it('applies a scheduled pause or cancel instead of charging', () => {
    expect(decide({ pendingStop: 'pause' })).toBe('pause');
    expect(decide({ pendingStop: 'cancel' })).toBe('cancel');
  });

  it.each(['pending_payment', 'past_due', 'paused', 'canceled'] as const)(
    'leaves %s subscriptions alone',
    (status) => {
      expect(decide({ status })).toBe('not_due');
    },
  );

  it('ignores a subscription with no paid period yet', () => {
    expect(decide({ paidThrough: null })).toBe('not_due');
  });
});
