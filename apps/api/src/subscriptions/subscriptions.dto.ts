import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CheckoutDto {
  /** Trimmed and lowercased before validation, so the same person never becomes two customers. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @IsUUID()
  planId!: string;

  /** Prepaid cycles to buy now. 1 (default) pays cycle by cycle. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  termCycles?: number;
}

export interface CheckoutView {
  subscriptionId: string;
  checkoutUrl: string;
  amountCents: number;
  currency: string;
  /** What the customer is buying, e.g. "12 weeks". */
  term: string;
}

export interface SubscriptionView {
  id: string;
  status: 'pending_payment' | 'active' | 'past_due' | 'paused' | 'canceled';
  planId: string;
  planName: string;
  termCycles: number;
  anchorAt: Date | null;
  paidThroughAt: Date | null;
  /** A pause or cancel waiting for the end of the paid cycle. */
  pendingStop: 'pause' | 'cancel' | null;
  /** While past_due: when the next payment attempt will be made. */
  nextRetryAt: Date | null;
  createdAt: Date;
}

export interface StopView extends SubscriptionView {
  /** When the pause or cancel takes effect: now, or the end of the paid cycle. */
  effectiveAt: Date;
}
