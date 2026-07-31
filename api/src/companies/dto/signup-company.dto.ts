import { Equals, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsAbn } from '../../common/validators/is-abn.validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

export class SignupCompanyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  adminUsername!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  adminPassword!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  adminFullName!: string;

  /** Optional at signup, but required to receive a verification or reset email. */
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  adminEmail?: string;

  // Auth/Billing Platform Phase 4 (registration depth) — org intake fields.

  /** Australian Business Number — optional (not every company provides one immediately), but validated against the real ABR checksum when given. */
  @IsOptional()
  @IsAbn()
  abn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  fleetSizeEstimate?: number;

  /**
   * Mandatory — this endpoint creates a real company/billing account, so a
   * signup can't complete without confirming acceptance of the Terms of
   * Service/Privacy Policy (FleetOS-Playbook/20-Legal/Terms_of_Service.DRAFT.md,
   * Privacy_Policy.DRAFT.md). `@Equals(true)` rather than `@IsBoolean()`
   * alone — submitting `false` must fail validation, not silently proceed.
   */
  @IsBoolean()
  @Equals(true, { message: 'You must accept the Terms of Service and Privacy Policy to create a company.' })
  acceptedTerms!: boolean;
}
