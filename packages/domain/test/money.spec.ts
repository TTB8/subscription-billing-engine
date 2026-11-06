import { assertCents, percentOfBps } from '../src/money';
import { InvalidArgumentError } from '../src/errors';

describe('assertCents', () => {
  it('accepts zero and positive integers', () => {
    expect(() => assertCents(0)).not.toThrow();
    expect(() => assertCents(1999)).not.toThrow();
  });

  it.each([1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('rejects %p', (value) => {
    expect(() => assertCents(value)).toThrow(InvalidArgumentError);
  });
});

describe('percentOfBps', () => {
  it('takes an exact percentage', () => {
    expect(percentOfBps(10_000, 1000)).toBe(1000);
  });

  it('rounds half up to the nearest cent', () => {
    expect(percentOfBps(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOfBps(4, 1000)).toBe(0); // 0.4 -> 0
    expect(percentOfBps(15, 1000)).toBe(2); // 1.5 -> 2
  });

  it('handles 0% and 100%', () => {
    expect(percentOfBps(12_345, 0)).toBe(0);
    expect(percentOfBps(12_345, 10_000)).toBe(12_345);
  });

  it.each([-1, 10_001, 1.5, NaN])('rejects bps %p', (bps) => {
    expect(() => percentOfBps(100, bps)).toThrow(InvalidArgumentError);
  });

  it('rejects a non-integer amount', () => {
    expect(() => percentOfBps(10.5, 1000)).toThrow(InvalidArgumentError);
  });
});
