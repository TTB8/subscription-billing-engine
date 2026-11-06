/**
 * @file Request and response shapes for refunds and the ledger.
 */

import { IsInt, IsOptional, Min } from 'class-validator';

/** Body of a refund request. */
export class RefundDto {
  /** Amount to refund in cents. Omit to refund everything still refundable. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountCents?: number;
}

/** The result of a refund: the new ledger row and where the charge stands. */
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

/** One ledger row as the API returns it. */
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

/**
 * A subscription's ledger: every entry in order, plus totals of the money that actually moved.
 */
export interface LedgerView {
  subscriptionId: string;
  chargedCents: number;
  refundedCents: number;
  netCents: number;
  entries: LedgerEntryView[];
}
