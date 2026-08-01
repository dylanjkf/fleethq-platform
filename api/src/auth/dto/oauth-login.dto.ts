import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class OAuthLoginDto {
  /** The identity provider's signed id_token — verified server-side, never trusted as-is. */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  idToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceFingerprint?: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
