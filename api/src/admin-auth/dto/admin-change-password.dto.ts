import { IsString, MaxLength, MinLength } from 'class-validator';

export class AdminChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  // Strength is enforced in the service via isStrongPassword (shared with the
  // rest of the platform); the length cap here only bounds request size.
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;
}
