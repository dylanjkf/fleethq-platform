import { IntegrationTransform } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Min, MaxLength, MinLength } from 'class-validator';

export class CreateFieldMappingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  externalField!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fleetField!: string;

  @IsOptional()
  @IsEnum(IntegrationTransform)
  transform?: IntegrationTransform;

  /** Transform-specific parameters — see IntegrationTransformService. */
  @IsOptional()
  @IsObject()
  transformConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class UpdateFieldMappingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  externalField?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fleetField?: string;

  @IsOptional()
  @IsEnum(IntegrationTransform)
  transform?: IntegrationTransform;

  @IsOptional()
  @IsObject()
  transformConfig?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}
