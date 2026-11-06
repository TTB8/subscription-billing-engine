import { InvalidArgumentError, RefundError } from '../src/errors';
import { resolveRefund } from '../src/refunds';

describe('resolveRefund', () => {
  it('refunds everything remaining when no amount is requested', () => {
    expect(resolveRefund({ chargedCents: 4900, refundedCents: 0 })).toBe(4900);
    expect(resolveRefund({ chargedCents: 4900, refundedCents: 1000 })).toBe(3900);
  });

  it('allows a partial refund', () => {
    expect(resolveRefund({ chargedCents: 4900, refundedCents: 0, requestedCents: 1 })).toBe(1);
    expect(resolveRefund({ chargedCents: 4900, refundedCents: 1000, requestedCents: 2000 })).toBe(
      2000,
    );
  });

  it('allows refunding exactly what remains', () => {
    expect(resolveRefund({ chargedCents: 4900, refundedCents: 4000, requestedCents: 900 })).toBe(
      900,
    );
  });

  it('rejects more than what remains, naming the amounts', () => {
    expect(() =>
      resolveRefund({ chargedCents: 4900, refundedCents: 4000, requestedCents: 901 }),
    ).toThrow(new RefundError('Cannot refund 901: only 900 remains refundable'));
  });

  it('rejects any refund of a charge that is already fully refunded', () => {
    expect(() => resolveRefund({ chargedCents: 4900, refundedCents: 4900 })).toThrow(RefundError);
    expect(() =>
      resolveRefund({ chargedCents: 4900, refundedCents: 4900, requestedCents: 1 }),
    ).toThrow(RefundError);
  });

  it('rejects a zero-value charge, which has nothing to refund', () => {
    expect(() => resolveRefund({ chargedCents: 0, refundedCents: 0 })).toThrow(RefundError);
  });

  it.each([0, -5, 1.5, NaN])('rejects an invalid requested amount %p', (requestedCents) => {
    expect(() => resolveRefund({ chargedCents: 4900, refundedCents: 0, requestedCents })).toThrow(
      InvalidArgumentError,
    );
  });

  it('refuses to work from an inconsistent ledger', () => {
    expect(() => resolveRefund({ chargedCents: 100, refundedCents: 101 })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects non-integer or negative ledger inputs', () => {
    expect(() => resolveRefund({ chargedCents: 49.5, refundedCents: 0 })).toThrow(
      InvalidArgumentError,
    );
    expect(() => resolveRefund({ chargedCents: 100, refundedCents: -1 })).toThrow(
      InvalidArgumentError,
    );
  });
});
