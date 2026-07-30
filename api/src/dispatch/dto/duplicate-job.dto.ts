import { IsDateString, IsOptional } from 'class-validator';

export class DuplicateJobDto {
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
