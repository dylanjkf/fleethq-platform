import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

export class SignupCompanyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  adminUsername!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  adminPassword!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  adminFullName!: string;

  /** Optional at signup, but required to receive a verification or reset email. */
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  adminEmail?: string;
}
