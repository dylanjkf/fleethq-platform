import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListShiftsDto {
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
