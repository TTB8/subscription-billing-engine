import { InvalidArgumentError } from './errors';
import { addDays } from './cycle';

/** Retry offsets in days after the original due date: +1, +3, +7. */
export const DEFAULT_RETRY_SCHEDULE_DAYS: readonly number[] = [1, 3, 7];

export type DunningAction = { type: 'retry'; at: Date; retryNumber: number } | { type: 'cancel' };

export function assertRetrySchedule(schedule: readonly number[]): void {
  let previous = 0;
  for (const days of schedule) {
    if (!Number.isInteger(days) || days <= previous) {
      throw new InvalidArgumentError(
        'retry schedule must be strictly increasing positive integers',
      );
    }
    previous = days;
  }
}

/**
 * What to do after a failed charge.
 *
 * `failureCount` counts every failed attempt for the current cycle, including
 * the original renewal (so the first failure is 1). Retries are anchored to
 * the ORIGINAL due date, not to when a failure happened, so the schedule is
 * deterministic and a slow job run cannot push later retries back.
 *
 * With the default schedule: failure 1 -> retry at due+1d, failure 2 -> due+3d,
 * failure 3 -> due+7d, failure 4 -> cancel.
 */
export function nextDunningAction(input: {
  dueAt: Date;
  failureCount: number;
  schedule?: readonly number[];
}): DunningAction {
  const { dueAt, failureCount, schedule = DEFAULT_RETRY_SCHEDULE_DAYS } = input;
  assertRetrySchedule(schedule);
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new InvalidArgumentError('failureCount must be an integer >= 1');
  }
  const offset = schedule[failureCount - 1];
  if (offset === undefined) {
    return { type: 'cancel' };
  }
  return { type: 'retry', at: addDays(dueAt, offset), retryNumber: failureCount };
}

export function isRetryDue(nextRetryAt: Date, now: Date): boolean {
  return now >= nextRetryAt;
}
