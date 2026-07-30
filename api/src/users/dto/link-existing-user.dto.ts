import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LinkExistingUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  username!: string;

  @IsUUID()
  roleId!: string;
}
