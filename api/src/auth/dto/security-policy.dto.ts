import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/** A login blocked by a company's mandatory-MFA policy: begin enrolment. */
export class PolicyMfaSetupBeginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  setupToken!: string;
}

/** Confirm that enrolment, completing the blocked login. */
export class PolicyMfaSetupConfirmDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  setupToken!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

/** A login blocked by a company's password-expiry policy: set a new password. */
export class PasswordExpiredChangeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  changeToken!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  newPassword!: string;
}

/** Self-service change while already logged in. */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  newPassword!: string;
}
