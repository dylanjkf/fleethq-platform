import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContact?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  make?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  registration?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  odometer?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  odometerUnit?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
