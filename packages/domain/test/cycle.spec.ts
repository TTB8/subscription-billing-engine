import { addDays, isDueForRenewal, periodForPayment, termLabel } from '../src/cycle';
import { InvalidArgumentError } from '../src/errors';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('addDays', () => {
  it('adds exact 24h blocks', () => {
    expect(iso(addDays(utc('2025-01-01'), 28))).toBe('2025-01-29');
  });

  it('is unaffected by leap years', () => {
    expect(iso(addDays(utc('2024-02-14'), 28))).toBe('2024-03-13'); // 2024 has Feb 29
    expect(iso(addDays(utc('2025-02-14'), 28))).toBe('2025-03-14');
  });

  it('is unaffected by DST changes', () => {
    // Europe/US clocks change on these weekends; UTC arithmetic does not care.
    const start = new Date('2025-03-09T12:00:00.000Z');
    expect(addDays(start, 28).toISOString()).toBe('2025-04-06T12:00:00.000Z');
    const autumn = new Date('2025-10-20T12:00:00.000Z');
    expect(addDays(autumn, 28).toISOString()).toBe('2025-11-17T12:00:00.000Z');
  });

  it('crosses year boundaries', () => {
    expect(iso(addDays(utc('2025-12-20'), 28))).toBe('2026-01-17');
  });
});

describe('periodForPayment', () => {
  const base = { cycleDays: 28, cycles: 1 };

  it('anchors the first period to the payment time, not a calendar date', () => {
    const paidAt = new Date('2025-03-17T14:32:10.000Z');
    const p = periodForPayment({ ...base, paidAt, paidThrough: null });
    expect(p.start).toEqual(paidAt);
    expect(p.end.toISOString()).toBe('2025-04-14T14:32:10.000Z');
  });

  it('continues from the previous period end on an on-time renewal', () => {
    const paidThrough = utc('2025-04-14');
    const p = periodForPayment({ ...base, paidAt: utc('2025-04-14'), paidThrough });
    expect(p.start).toEqual(paidThrough);
    expect(iso(p.end)).toBe('2025-05-12');
  });

  it('does not shift the cycle when paying early', () => {
    const paidThrough = utc('2025-04-14');
    const p = periodForPayment({ ...base, paidAt: utc('2025-04-10'), paidThrough });
    expect(p.start).toEqual(paidThrough);
  });

  it('restarts at the payment date on a late payment', () => {
    const paidThrough = utc('2025-04-14');
    const paidAt = utc('2025-04-20');
    const p = periodForPayment({ ...base, paidAt, paidThrough });
    expect(p.start).toEqual(paidAt);
    expect(iso(p.end)).toBe('2025-05-18');
  });

  it('treats a payment one millisecond late as late', () => {
    const paidThrough = utc('2025-04-14');
    const paidAt = new Date(paidThrough.getTime() + 1);
    expect(periodForPayment({ ...base, paidAt, paidThrough }).start).toEqual(paidAt);
  });

  it('covers a whole prepaid term', () => {
    const p = periodForPayment({
      cycleDays: 28,
      cycles: 3,
      paidAt: utc('2025-01-01'),
      paidThrough: null,
    });
    expect(iso(p.end)).toBe('2025-03-26'); // 84 days
  });

  it('survives repeated renewals without drift', () => {
    let paidThrough: Date | null = null;
    const first = utc('2024-01-31');
    let paidAt = first;
    for (let i = 0; i < 20; i++) {
      const p = periodForPayment({ ...base, paidAt, paidThrough });
      paidThrough = p.end;
      paidAt = p.end;
    }
    expect(paidThrough).toEqual(addDays(first, 28 * 20));
  });

  it.each([0, -1, 1.5])('rejects cycleDays %p', (cycleDays) => {
    expect(() =>
      periodForPayment({ cycleDays, cycles: 1, paidAt: utc('2025-01-01'), paidThrough: null }),
    ).toThrow(InvalidArgumentError);
  });

  it.each([0, -1, 1.5])('rejects cycles %p', (cycles) => {
    expect(() =>
      periodForPayment({ cycleDays: 28, cycles, paidAt: utc('2025-01-01'), paidThrough: null }),
    ).toThrow(InvalidArgumentError);
  });
});

describe('isDueForRenewal', () => {
  const paidThrough = utc('2025-04-14');

  it('is not due while coverage remains', () => {
    expect(isDueForRenewal(paidThrough, new Date(paidThrough.getTime() - 1))).toBe(false);
  });

  it('is due exactly when coverage ends and after', () => {
    expect(isDueForRenewal(paidThrough, paidThrough)).toBe(true);
    expect(isDueForRenewal(paidThrough, utc('2025-05-01'))).toBe(true);
  });
});

describe('termLabel', () => {
  it('names terms by length in weeks', () => {
    expect(termLabel(1, 28)).toBe('4 weeks');
    expect(termLabel(3, 28)).toBe('12 weeks');
    expect(termLabel(6, 28)).toBe('24 weeks');
  });

  it('uses the singular for one week', () => {
    expect(termLabel(1, 7)).toBe('1 week');
  });

  it('falls back to days when the length is not a whole number of weeks', () => {
    expect(termLabel(1, 30)).toBe('30 days');
    expect(termLabel(1, 1)).toBe('1 day');
  });

  it('rejects invalid input', () => {
    expect(() => termLabel(0, 28)).toThrow(InvalidArgumentError);
    expect(() => termLabel(1, 0)).toThrow(InvalidArgumentError);
  });
});
