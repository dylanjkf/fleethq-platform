import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class MagicLinkRequestDto {
  /** Username or email — either identifies the account. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  identifier!: string;
}

export class MagicLinkConsumeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceFingerprint?: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
