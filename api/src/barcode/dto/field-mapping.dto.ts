import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BarcodeFieldTarget } from '@prisma/client';

const SAFE_KEY = /^[a-zA-Z0-9_]+$/;

export class CreateFieldMappingDto {
  /** Either the literal `'scan'` (the raw/decoded scan payload) or a BarcodeSearchableField.key. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sourceField!: string;

  @IsEnum(BarcodeFieldTarget)
  targetField!: BarcodeFieldTarget;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(SAFE_KEY, { message: 'customFieldKey must be alphanumeric/underscore only' })
  customFieldKey?: string;

  @IsOptional()
  @IsBoolean()
  isDatabaseLookup?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}

export class UpdateFieldMappingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sourceField?: string;

  @IsOptional()
  @IsEnum(BarcodeFieldTarget)
  targetField?: BarcodeFieldTarget;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(SAFE_KEY, { message: 'customFieldKey must be alphanumeric/underscore only' })
  customFieldKey?: string;

  @IsOptional()
  @IsBoolean()
  isDatabaseLookup?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}
