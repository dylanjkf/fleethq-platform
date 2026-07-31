import { IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const ANNOUNCEMENT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export class CreateAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_SEVERITIES)
  severity?: (typeof ANNOUNCEMENT_SEVERITIES)[number];

  /** Omitted/null = starts immediately. */
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  /** Omitted/null = never expires. */
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
