import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCheckoutSessionDto {
  /** A Stripe Price ID (e.g. "price_..."), not an internal plan key — see BillingService's own doc comment. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  priceId!: string;

  /**
   * For the per-asset plan, the number of asset slots to purchase (the value
   * that becomes the company's hard cap). Ignored for fixed-tier prices, which
   * are always quantity 1. Defaults to 1 when omitted.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity?: number;

  @IsUrl({ require_tld: false })
  successUrl!: string;

  @IsUrl({ require_tld: false })
  cancelUrl!: string;
}
