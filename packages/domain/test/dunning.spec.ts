import {
  assertRetrySchedule,
  DEFAULT_RETRY_SCHEDULE_DAYS,
  isRetryDue,
  nextDunningAction,
} from '../src/dunning';
import { InvalidArgumentError } from '../src/errors';

const dueAt = new Date('2025-06-01T09:00:00.000Z');

describe('nextDunningAction', () => {
  it('uses +1, +3, +7 days by default', () => {
    expect(DEFAULT_RETRY_SCHEDULE_DAYS).toEqual([1, 3, 7]);
  });

  it('schedules each retry from the ORIGINAL due date', () => {
    const at = (n: number) => {
      const a = nextDunningAction({ dueAt, failureCount: n });
      return a.type === 'retry' ? a.at.toISOString() : a.type;
    };
    expect(at(1)).toBe('2025-06-02T09:00:00.000Z');
    expect(at(2)).toBe('2025-06-04T09:00:00.000Z');
    expect(at(3)).toBe('2025-06-08T09:00:00.000Z');
  });

  it('reports which retry is next', () => {
    expect(nextDunningAction({ dueAt, failureCount: 2 })).toMatchObject({ retryNumber: 2 });
  });

  it('cancels after the final retry fails', () => {
    expect(nextDunningAction({ dueAt, failureCount: 4 })).toEqual({ type: 'cancel' });
    expect(nextDunningAction({ dueAt, failureCount: 9 })).toEqual({ type: 'cancel' });
  });

  it('supports a custom schedule', () => {
    expect(nextDunningAction({ dueAt, failureCount: 1, schedule: [2] })).toMatchObject({
      type: 'retry',
    });
    expect(nextDunningAction({ dueAt, failureCount: 2, schedule: [2] })).toEqual({
      type: 'cancel',
    });
  });

  it('cancels at once with an empty schedule', () => {
    expect(nextDunningAction({ dueAt, failureCount: 1, schedule: [] })).toEqual({
      type: 'cancel',
    });
  });

  it.each([0, -1, 1.5])('rejects failureCount %p', (failureCount) => {
    expect(() => nextDunningAction({ dueAt, failureCount })).toThrow(InvalidArgumentError);
  });
});

describe('assertRetrySchedule', () => {
  it('accepts increasing positive integers', () => {
    expect(() => assertRetrySchedule([1, 3, 7])).not.toThrow();
    expect(() => assertRetrySchedule([])).not.toThrow();
  });

  it.each([[[3, 1]], [[1, 1]], [[0, 2]], [[1.5]], [[-1]]])('rejects %p', (schedule) => {
    expect(() => assertRetrySchedule(schedule)).toThrow(InvalidArgumentError);
  });
});

describe('isRetryDue', () => {
  it('is due at and after the retry time only', () => {
    const at = new Date('2025-06-02T09:00:00.000Z');
    expect(isRetryDue(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isRetryDue(at, at)).toBe(true);
    expect(isRetryDue(at, new Date(at.getTime() + 1))).toBe(true);
  });
});
