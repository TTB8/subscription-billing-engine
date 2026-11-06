import { InvalidArgumentError } from './errors';
import { assertCents, Cents, percentOfBps } from './money';

export interface TermPriceInput {
  /** Price of a single cycle. */
  priceCents: Cents;
  /** Number of cycles prepaid in one payment. */
  cycles: number;
  /** Discount for the term in basis points (1000 = 10%). */
  discountBps: number;
}

export interface TermPrice {
  grossCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
}

/**
 * Price of a prepaid term. The discount is applied once, to the gross term
 * amount, so the total is never off by a cent per cycle.
 */
export function priceTerm({ priceCents, cycles, discountBps }: TermPriceInput): TermPrice {
  assertCents(priceCents, 'priceCents');
  if (!Number.isInteger(cycles) || cycles < 1) {
    throw new InvalidArgumentError('cycles must be an integer >= 1');
  }
  const grossCents = priceCents * cycles;
  assertCents(grossCents, 'grossCents');
  const discountCents = percentOfBps(grossCents, discountBps);
  return { grossCents, discountCents, totalCents: grossCents - discountCents };
}
