import { IsString, MaxLength, MinLength } from 'class-validator';

/** A submitted second-factor value — a 6-digit TOTP or a backup code. */
export class MfaCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

/** The MFA challenge step of login: the challenge token plus a code. */
export class MfaVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  mfaToken!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}
