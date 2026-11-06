import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreatePlanTermDto {
  /** Prepaid cycles in one payment. A single cycle is always available, so terms start at 2. */
  @IsInt()
  @Min(2)
  @Max(52)
  cycles!: number;

  /** Discount in basis points: 1000 = 10%. */
  @IsInt()
  @Min(0)
  @Max(10_000)
  discountBps!: number;
}

export class CreatePlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  /** Price of one cycle in minor units (cents). */
  @IsInt()
  @Min(0)
  priceCents!: number;

  /** Lowercase ISO 4217 code, e.g. "usd". */
  @Matches(/^[a-z]{3}$/)
  currency!: string;

  /** Cycle length in days. Defaults to 28. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  cycleDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => CreatePlanTermDto)
  terms?: CreatePlanTermDto[];
}

export interface PlanTermView {
  cycles: number;
  label: string;
  discountBps: number;
  grossCents: number;
  discountCents: number;
  totalCents: number;
}

export interface PlanView {
  id: string;
  name: string;
  currency: string;
  priceCents: number;
  cycleDays: number;
  /** Always includes the single-cycle option first. */
  terms: PlanTermView[];
}
