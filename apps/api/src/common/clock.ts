/**
 * @file The clock as an injectable dependency, so every time-based rule can be tested at a
 * chosen instant.
 */

/** All "now" reads go through this so tests can control time. */
export abstract class Clock {
  abstract now(): Date;
}

/** The real clock. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
