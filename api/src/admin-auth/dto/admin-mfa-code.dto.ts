import { IsString, MaxLength, MinLength } from 'class-validator';

/** A submitted second-factor value — a 6-digit TOTP or a backup code. */
export class AdminMfaCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}
