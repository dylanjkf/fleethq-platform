import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateSecuritySettingsDto {
  @IsOptional() @IsBoolean() mfaRequired?: boolean;
  /** `null` clears the policy (no expiry). Omit the field to leave it unchanged. */
  @IsOptional() @IsInt() @Min(7) @Max(365) passwordExpiryDays?: number | null;
}
