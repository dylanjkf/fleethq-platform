import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  // Usernames are email addresses here; cap at the RFC 5321 maximum so an
  // attacker can't send a multi-megabyte "username" to bloat logs or waste work.
  @MaxLength(320)
  username!: string;

  @IsString()
  @MinLength(1)
  // Bound the password too — bcrypt only reads the first 72 bytes anyway, so a
  // huge string is pure DoS surface (hashing/CPU) with no legitimate use.
  @MaxLength(200)
  password!: string;
}
