import { IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

const CREDIT_NOTE_REASONS = ['duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory'] as const;

export class CreditNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  invoiceId!: string;

  /** In cents — the exact amount to credit (Stripe requires an explicit amount, not an implicit "full remaining balance"). */
  @IsInt()
  @IsPositive()
  amountCents!: number;

  @IsOptional()
  @IsIn(CREDIT_NOTE_REASONS)
  reason?: (typeof CREDIT_NOTE_REASONS)[number];
}
