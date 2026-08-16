import { Equals, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/**
 * Public self-serve signup body (POST /v1/signup). Everything financial
 * (quantity, price) is re-validated/-computed server-side — the client is never
 * trusted for the charge amount. No free trial: this only starts a Stripe
 * Checkout; the account is provisioned by the webhook once payment succeeds.
 */
export class SignupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  adminName!: string;

  /** Becomes the admin's login identifier (username = email) and contact email. */
  @IsEmail()
  @MaxLength(200)
  adminEmail!: string;

  /**
   * Hashed at intake so plaintext never persists in the pending_signups row.
   * Enforces the shared password policy (8+ chars, all four character classes)
   * — previously this intake only checked length, unlike every other
   * password-set flow. MaxLength 72 is the bcrypt input ceiling.
   */
  @IsString()
  @IsStrongPassword()
  @MinLength(8)
  @MaxLength(72)
  adminPassword!: string;

  /** Number of asset slots to purchase — the initial paid quantity / hard cap. */
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  /** Must be true — records ToS/Privacy acceptance at signup. */
  @IsBoolean()
  @Equals(true)
  acceptedTerms!: boolean;

  /**
   * Honeypot: a hidden field real users never fill. A non-empty value is almost
   * certainly a bot, so the request is rejected. Named innocuously so scripts
   * auto-fill it.
   */
  @IsOptional()
  @IsString()
  website?: string;
}
