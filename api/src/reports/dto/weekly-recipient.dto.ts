import { IsEmail, MaxLength } from 'class-validator';

/** A single weekly-report recipient email (Part 4). */
export class WeeklyRecipientDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
