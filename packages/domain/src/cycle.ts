/**
 * @file Billing cycle arithmetic. A cycle is a fixed number of days anchored to the moment a
 * payment cleared, never to a calendar date, so the same rules hold in every month, leap year
 * and timezone.
 */

import { InvalidArgumentError } from './errors';

const MS_PER_DAY = 86_400_000;

/** A span of paid coverage: it starts at `start` and runs until `end`. */
export interface Period {
  start: Date;
  end: Date;
}

function assertCycleDays(cycleDays: number): void {
  if (!Number.isInteger(cycleDays) || cycleDays < 1) {
    throw new InvalidArgumentError('cycleDays must be an integer >= 1');
  }
}

function assertCycles(cycles: number): void {
  if (!Number.isInteger(cycles) || cycles < 1) {
    throw new InvalidArgumentError('cycles must be an integer >= 1');
  }
}

/**
 * Adds whole days as exact 24h blocks in UTC. There is no calendar or
 * timezone logic here, so leap years and DST cannot affect a cycle.
 */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * The period covered by a payment of `cycles` cycles.
 *
 * - First payment (`paidThrough` is null): starts when the payment clears.
 *   That instant is the subscription's anchor.
 * - On-time or early renewal (`paidAt <= paidThrough`): starts where the
 *   previous period ended, so paying early never shortens or shifts a cycle.
 * - Late payment (`paidAt > paidThrough`): restarts at the payment date.
 *   The customer is never charged for days they had no coverage.
 */
export function periodForPayment(input: {
  paidAt: Date;
  paidThrough: Date | null;
  cycleDays: number;
  cycles: number;
}): Period {
  const { paidAt, paidThrough, cycleDays, cycles } = input;
  assertCycleDays(cycleDays);
  assertCycles(cycles);
  const start = paidThrough !== null && paidAt <= paidThrough ? paidThrough : paidAt;
  return { start, end: addDays(start, cycleDays * cycles) };
}

/** A subscription is due once its paid coverage has run out. */
export function isDueForRenewal(paidThrough: Date, now: Date): boolean {
  return now >= paidThrough;
}

/** Human label for a term, named by length: "12 weeks", never months. */
export function termLabel(cycles: number, cycleDays: number): string {
  assertCycleDays(cycleDays);
  assertCycles(cycles);
  const totalDays = cycles * cycleDays;
  if (totalDays % 7 === 0) {
    const weeks = totalDays / 7;
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
  }
  return `${totalDays} ${totalDays === 1 ? 'day' : 'days'}`;
}
