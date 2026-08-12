import { IsString, MaxLength, MinLength } from 'class-validator';

export class AdminForgotPasswordDto {
  /** Username or email — either identifies the admin account. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  identifier!: string;
}

export class AdminResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  // Strength is enforced in the service via isStrongPassword (shared with the
  // admin change-password path); the length bounds here only bound request size.
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;
}
