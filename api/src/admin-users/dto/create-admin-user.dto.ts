import { IsEmail, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/**
 * Onboard a second FleetHQ staff member without touching the DB or the
 * bootstrap script. Mirrors the AdminUser the bootstrap script creates
 * (username/email/fullName/passwordHash/roleId) and the customer-user create
 * shape's validators. Unlike a customer user there is no invite-without-
 * password flow here — a staff account is always created with a password by
 * another admin, so `password` is required and policy-checked.
 */
export class CreateAdminUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  password!: string;

  @IsUUID()
  roleId!: string;
}
