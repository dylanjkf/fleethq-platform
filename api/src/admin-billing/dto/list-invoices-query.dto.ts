import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListInvoicesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  /** Stripe's own cursor pagination — the last invoice id from the previous page. */
  @IsOptional()
  @IsString()
  startingAfter?: string;
}
