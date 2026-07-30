import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @IsString()
  @MaxLength(320)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  /**
   * Client-generated device id (e.g. AdminAuthService.generateDeviceFingerprint(),
   * persisted in the admin SPA's localStorage) — lets a previously-trusted
   * device skip the MFA challenge. Never treated as a credential on its own.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceFingerprint?: string;
}

export class AdminMfaVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  mfaToken!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;

  /** "Remember this device for 30 days" — skips MFA on future logins from it. */
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}
