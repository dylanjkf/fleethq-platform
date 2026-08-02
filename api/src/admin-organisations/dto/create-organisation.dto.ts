import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Issue a brand-new customer organisation + its first Administrator login.
 * Intentionally minimal — only the company name and the admin's email — but
 * shaped so later fields (plan/tier, trial length, a chosen role, ABN, etc.)
 * slot in without reworking the callers: they'd become optional properties
 * here and optional args to provisionCompany(), which already accepts most of
 * them. The email doubles as the login username; a strong temporary password
 * is generated server-side (never taken from the client) and returned once.
 */
export class CreateOrganisationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyName!: string;

  @IsEmail()
  @MaxLength(320)
  adminEmail!: string;

  /** Optional display name for the admin; defaults to "<Company> Administrator". */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  adminFullName?: string;
}
