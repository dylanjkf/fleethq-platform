import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateMaintenanceJobDto {
  @IsUUID()
  assetId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  reportedByOperatorId?: string;

  /** Client-generated idempotency key so a DriverOS fault report replayed after
   *  a lost response can't open a duplicate workshop job. */
  @IsOptional()
  @IsUUID()
  clientRequestId?: string;
}
