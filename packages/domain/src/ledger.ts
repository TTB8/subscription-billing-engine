import { Cents } from './money';

export interface LedgerEntry {
  type: 'charge' | 'failure' | 'refund';
  amountCents: Cents;
}

export interface LedgerSummary {
  chargedCents: Cents;
  refundedCents: Cents;
  /** What the customer has actually paid: charged minus refunded. */
  netCents: Cents;
}

/** Failed attempts moved no money, so they are listed in the ledger but never summed. */
export function summarizeLedger(entries: readonly LedgerEntry[]): LedgerSummary {
  let chargedCents = 0;
  let refundedCents = 0;
  for (const entry of entries) {
    if (entry.type === 'charge') chargedCents += entry.amountCents;
    else if (entry.type === 'refund') refundedCents += entry.amountCents;
  }
  return { chargedCents, refundedCents, netCents: chargedCents - refundedCents };
}
