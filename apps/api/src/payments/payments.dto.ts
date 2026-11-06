import { IsInt, IsOptional, Min } from 'class-validator';

export class RefundDto {
  /** Amount to refund in cents. Omit to refund everything still refundable. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountCents?: number;
}

export interface RefundView {
  /** The new refund row in the ledger. */
  refundId: string;
  chargeId: string;
  amountCents: number;
  currency: string;
  /** Total refunded against the charge, including this refund. */
  refundedCents: number;
  remainingCents: number;
  /** "pending" means the provider accepted it and will complete it. */
  status: 'succeeded' | 'pending';
}

export interface LedgerEntryView {
  id: string;
  type: 'charge' | 'failure' | 'refund';
  amountCents: number;
  currency: string;
  periodStart: Date | null;
  attempt: number;
  gatewayRef: string | null;
  failureCode: string | null;
  refundOfId: string | null;
  createdAt: Date;
}

export interface LedgerView {
  subscriptionId: string;
  chargedCents: number;
  refundedCents: number;
  netCents: number;
  entries: LedgerEntryView[];
}
