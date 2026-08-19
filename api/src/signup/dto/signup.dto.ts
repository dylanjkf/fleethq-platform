import { Equals, IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/**
 * Public self-serve signup body (POST /v1/signup). The price is a fixed flat
 * monthly rate computed server-side (not sent by the client) — there is no
 * quantity/fleet-size input, since billing no longer scales with asset count.
 * Starts a Stripe Checkout that opens a 7-day free trial (TRIAL_PERIOD_DAYS);
 * the account is provisioned by the webhook once the checkout completes, and
 * billing begins after the trial.
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
