import { IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CreateCheckoutSessionDto {
  /** A Stripe Price ID (e.g. "price_..."), not an internal plan key — see BillingService's own doc comment. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  priceId!: string;

  @IsUrl({ require_tld: false })
  successUrl!: string;

  @IsUrl({ require_tld: false })
  cancelUrl!: string;
}
