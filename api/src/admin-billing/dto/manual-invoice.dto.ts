import { IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class ManualInvoiceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsInt()
  @IsPositive()
  amountCents!: number;

  /** Three-letter ISO currency code, lowercase. Defaults to "aud" (FleetOS's only supported jurisdiction, see Jurisdiction_Model.md) if omitted. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;
}
