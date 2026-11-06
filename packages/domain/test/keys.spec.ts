import { chargeIdempotencyKey, refundIdempotencyKey } from '../src/keys';

describe('idempotency keys', () => {
  it('derives the same charge key for the same inputs', () => {
    const a = chargeIdempotencyKey('sub_1', '2026-01-29T00:00:00.000Z', 1);
    expect(a).toBe('charge:sub_1:2026-01-29T00:00:00.000Z:1');
    expect(chargeIdempotencyKey('sub_1', '2026-01-29T00:00:00.000Z', 1)).toBe(a);
  });

  it('differs per subscription, due date and attempt', () => {
    const base = chargeIdempotencyKey('sub_1', '2026-01-29T00:00:00.000Z', 1);
    expect(chargeIdempotencyKey('sub_2', '2026-01-29T00:00:00.000Z', 1)).not.toBe(base);
    expect(chargeIdempotencyKey('sub_1', '2026-02-26T00:00:00.000Z', 1)).not.toBe(base);
    expect(chargeIdempotencyKey('sub_1', '2026-01-29T00:00:00.000Z', 2)).not.toBe(base);
  });

  it('derives refund keys from the charge and the refund position', () => {
    expect(refundIdempotencyKey('ch_1', 1)).toBe('refund:ch_1:1');
    expect(refundIdempotencyKey('ch_1', 2)).not.toBe(refundIdempotencyKey('ch_1', 1));
  });
});
