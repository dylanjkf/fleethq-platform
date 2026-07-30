import { IsDateString, IsOptional } from 'class-validator';

export class OperationsReportDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
