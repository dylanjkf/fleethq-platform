import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateChecklistBundleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  templateIds!: string[];
}

export class UpdateChecklistBundleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  templateIds?: string[];
}

/** Deploy the bundle's templates to an asset category (scope them to it), by key. */
export class DeployChecklistBundleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  assetClass!: string;
}
