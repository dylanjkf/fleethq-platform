import { IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateAssetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContact?: string;

  // Optional structured specs — all nullable, a company fills in what it wants.
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

  /** Free-form company-defined fields (key → value), never schema-migrated. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  /** The asset category, by id (from the category picker). Preferred. */
  @IsOptional()
  @IsUUID()
  assetClassId?: string;

  /** The asset category, by key (built-in default / CSV import). Defaults to 'LAND'. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assetClass?: string;
}
