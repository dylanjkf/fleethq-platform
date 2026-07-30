import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/** Mirrors the customer-facing CreateUserDto (src/users/dto/create-user.dto.ts) — same invite-without-password shape, for the support scenario of adding a user on a customer's behalf (e.g. their only admin left the company). */
export class CreateCustomerUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  /** Omit to invite instead: the user is created without a usable password and emailed a set-your-password link (requires `email`). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  password?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @IsUUID()
  roleId!: string;
}
