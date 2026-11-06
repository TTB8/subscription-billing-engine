import { InvalidArgumentError } from './errors';

/** Money is always an integer number of minor units (cents). Never a float. */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`${label} must be an integer number of minor units`);
  }
  if (value < 0) {
    throw new InvalidArgumentError(`${label} must not be negative`);
  }
}

export const BPS_DENOMINATOR = 10_000;

/**
 * Takes `bps` basis points of `amount`, rounding half up, using integer
 * arithmetic only so results never depend on floating point behaviour.
 */
export function percentOfBps(amount: Cents, bps: number): Cents {
  assertCents(amount);
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new InvalidArgumentError('bps must be an integer between 0 and 10000');
  }
  return Math.floor((amount * bps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
}
