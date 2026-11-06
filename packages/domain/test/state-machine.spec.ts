import { InvalidTransitionError } from '../src/errors';
import {
  canTransition,
  isTerminal,
  SubscriptionEvent,
  SubscriptionStatus,
  transition,
} from '../src/state-machine';

const STATUSES: SubscriptionStatus[] = [
  'pending_payment',
  'active',
  'past_due',
  'paused',
  'canceled',
];
const EVENTS: SubscriptionEvent[] = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAUSE',
  'CANCEL',
  'RETRIES_EXHAUSTED',
];

const LEGAL: Array<[SubscriptionStatus, SubscriptionEvent, SubscriptionStatus]> = [
  ['pending_payment', 'PAYMENT_SUCCEEDED', 'active'],
  ['pending_payment', 'PAYMENT_FAILED', 'pending_payment'],
  ['pending_payment', 'CANCEL', 'canceled'],
  ['active', 'PAYMENT_SUCCEEDED', 'active'],
  ['active', 'PAYMENT_FAILED', 'past_due'],
  ['active', 'PAUSE', 'paused'],
  ['active', 'CANCEL', 'canceled'],
  ['past_due', 'PAYMENT_SUCCEEDED', 'active'],
  ['past_due', 'PAYMENT_FAILED', 'past_due'],
  ['past_due', 'RETRIES_EXHAUSTED', 'canceled'],
  ['past_due', 'PAUSE', 'paused'],
  ['past_due', 'CANCEL', 'canceled'],
  ['paused', 'PAYMENT_SUCCEEDED', 'active'],
  ['paused', 'CANCEL', 'canceled'],
];

describe('subscription state machine', () => {
  it.each(LEGAL)('%s + %s -> %s', (from, event, to) => {
    expect(canTransition(from, event)).toBe(true);
    expect(transition(from, event)).toBe(to);
  });

  const illegal = STATUSES.flatMap((from) =>
    EVENTS.filter((event) => !LEGAL.some(([f, e]) => f === from && e === event)).map(
      (event) => [from, event] as const,
    ),
  );

  it.each(illegal)('%s + %s throws', (from, event) => {
    expect(canTransition(from, event)).toBe(false);
    expect(() => transition(from, event)).toThrow(InvalidTransitionError);
  });

  it('covers every status/event pair exactly once', () => {
    expect(LEGAL.length + illegal.length).toBe(STATUSES.length * EVENTS.length);
  });

  it('treats only canceled as terminal', () => {
    expect(STATUSES.filter(isTerminal)).toEqual(['canceled']);
  });

  it('follows the full recovery path', () => {
    let s: SubscriptionStatus = 'pending_payment';
    s = transition(s, 'PAYMENT_SUCCEEDED');
    s = transition(s, 'PAYMENT_FAILED');
    s = transition(s, 'PAYMENT_FAILED');
    s = transition(s, 'PAYMENT_SUCCEEDED');
    expect(s).toBe('active');
  });

  it('follows the exhaustion path to canceled', () => {
    let s: SubscriptionStatus = 'active';
    s = transition(s, 'PAYMENT_FAILED');
    s = transition(s, 'RETRIES_EXHAUSTED');
    expect(s).toBe('canceled');
  });
});
