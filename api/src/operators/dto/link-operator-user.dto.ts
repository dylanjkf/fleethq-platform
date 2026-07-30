import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../../common/validators/is-strong-password.validator';

/**
 * No `fullName` here — the new User is created with the Operator's own
 * `fullName`, per "zero duplicate data entry" (CLAUDE.md). The Operator
 * record's name is what already appears on Jobs and Maintenance reports.
 */
export class LinkOperatorUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  @IsString()
  @MaxLength(200)
  @IsStrongPassword()
  password!: string;

  @IsUUID()
  roleId!: string;
}
