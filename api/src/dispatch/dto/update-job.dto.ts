import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Job details only — assignment and status transitions have their own dedicated endpoints. */
export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
