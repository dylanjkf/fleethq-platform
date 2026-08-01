import { IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;

export class RefundDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  invoiceId!: string;

  /** Omit for a full refund of the invoice's payment. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  amountCents?: number;

  @IsOptional()
  @IsIn(REFUND_REASONS)
  reason?: (typeof REFUND_REASONS)[number];
}
