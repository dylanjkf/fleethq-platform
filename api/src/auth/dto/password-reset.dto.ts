import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

export class ForgotPasswordDto {
  /** Username or email — either identifies the account. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  identifier!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  newPassword!: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;
}

export class ResendVerificationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  identifier!: string;
}
