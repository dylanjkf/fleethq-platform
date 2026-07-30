import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  /**
   * Omit to *invite* instead: the user is created without a usable password and
   * emailed a set-your-password link (which requires `email` to be present).
   * Provide it to create the account with a password directly, as before.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  password?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  /** Required when inviting (no password); optional otherwise, enabling reset later. */
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @IsUUID()
  roleId!: string;
}
