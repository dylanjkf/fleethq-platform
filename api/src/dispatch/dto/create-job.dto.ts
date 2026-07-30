import { IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateJobDto {
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
  assetId?: string;

  @IsOptional()
  @IsUUID()
  operatorId?: string;

  /** The fleet's own pickup location for this run, if any (see Depot). */
  @IsOptional()
  @IsUUID()
  pickupDepotId?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
