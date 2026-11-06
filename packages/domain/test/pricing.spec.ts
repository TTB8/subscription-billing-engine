import { priceTerm } from '../src/pricing';
import { InvalidArgumentError } from '../src/errors';

describe('priceTerm', () => {
  it('charges the plain price for one cycle with no discount', () => {
    expect(priceTerm({ priceCents: 4900, cycles: 1, discountBps: 0 })).toEqual({
      grossCents: 4900,
      discountCents: 0,
      totalCents: 4900,
    });
  });

  it('applies 10% off a 3-cycle term', () => {
    expect(priceTerm({ priceCents: 4900, cycles: 3, discountBps: 1000 })).toEqual({
      grossCents: 14_700,
      discountCents: 1470,
      totalCents: 13_230,
    });
  });

  it('applies 15% off a 6-cycle term', () => {
    expect(priceTerm({ priceCents: 4900, cycles: 6, discountBps: 1500 })).toEqual({
      grossCents: 29_400,
      discountCents: 4410,
      totalCents: 24_990,
    });
  });

  it('applies the discount once to the gross, not per cycle', () => {
    // 3 x 333 = 999; 10% of 999 = 99.9 -> 100. Per-cycle rounding would give 3 x 33 = 99.
    const { discountCents, totalCents } = priceTerm({
      priceCents: 333,
      cycles: 3,
      discountBps: 1000,
    });
    expect(discountCents).toBe(100);
    expect(totalCents).toBe(899);
  });

  it('always returns integers that add up', () => {
    for (const cycles of [1, 2, 3, 6, 13]) {
      for (const discountBps of [0, 250, 999, 1000, 1500, 3333]) {
        const p = priceTerm({ priceCents: 1999, cycles, discountBps });
        expect(Number.isInteger(p.totalCents)).toBe(true);
        expect(p.grossCents - p.discountCents).toBe(p.totalCents);
      }
    }
  });

  it('allows a free plan', () => {
    expect(priceTerm({ priceCents: 0, cycles: 3, discountBps: 1000 }).totalCents).toBe(0);
  });

  it.each([0, -1, 1.5, NaN])('rejects cycles %p', (cycles) => {
    expect(() => priceTerm({ priceCents: 100, cycles, discountBps: 0 })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a fractional price', () => {
    expect(() => priceTerm({ priceCents: 49.99, cycles: 1, discountBps: 0 })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a gross amount beyond the safe integer range', () => {
    expect(() =>
      priceTerm({ priceCents: Number.MAX_SAFE_INTEGER, cycles: 2, discountBps: 0 }),
    ).toThrow(InvalidArgumentError);
  });
});
