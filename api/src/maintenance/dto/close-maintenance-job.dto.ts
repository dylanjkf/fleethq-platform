import { IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class CloseMaintenanceJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNotes?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  partsCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  laborCost?: number;
}
