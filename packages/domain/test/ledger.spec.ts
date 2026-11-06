import { summarizeLedger } from '../src/ledger';

describe('summarizeLedger', () => {
  it('is zero for an empty ledger', () => {
    expect(summarizeLedger([])).toEqual({ chargedCents: 0, refundedCents: 0, netCents: 0 });
  });

  it('adds charges and subtracts refunds', () => {
    expect(
      summarizeLedger([
        { type: 'charge', amountCents: 4900 },
        { type: 'charge', amountCents: 4900 },
        { type: 'refund', amountCents: 1000 },
      ]),
    ).toEqual({ chargedCents: 9800, refundedCents: 1000, netCents: 8800 });
  });

  it('ignores failed attempts, which moved no money', () => {
    expect(
      summarizeLedger([
        { type: 'failure', amountCents: 4900 },
        { type: 'failure', amountCents: 4900 },
        { type: 'charge', amountCents: 4900 },
      ]),
    ).toEqual({ chargedCents: 4900, refundedCents: 0, netCents: 4900 });
  });

  it('can go negative only if refunds exceed charges, which the refund rules prevent', () => {
    expect(summarizeLedger([{ type: 'refund', amountCents: 5 }]).netCents).toBe(-5);
  });
});
