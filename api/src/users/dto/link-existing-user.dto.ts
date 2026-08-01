import { IsEmail, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LinkExistingUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  username!: string;

  /**
   * The target user's registered email. Required so that granting an existing
   * identity access to this company can't double as a platform-wide
   * username-enumeration oracle: knowing only a username is never enough to
   * confirm the account exists — the caller must also supply the matching
   * email, which they'd only have if they already know the person. A mismatch
   * returns the same "not found" as a nonexistent username.
   */
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsUUID()
  roleId!: string;
}
