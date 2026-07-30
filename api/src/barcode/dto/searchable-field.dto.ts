import { IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Alphanumeric + underscore only — used both as a Postgres JSON property name
 *  (customFields->>key) for isCustom fields and, for built-in fields, as the
 *  identifier BarcodeFieldMapping.sourceField/scan-decode keys are matched
 *  against, so it must be a safe "bare word" in both contexts. */
const SAFE_KEY = /^[a-zA-Z0-9_]+$/;

export class CreateSearchableFieldDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(SAFE_KEY, { message: 'key must be alphanumeric/underscore only' })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}

export class UpdateSearchableFieldDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsInt()
  order?: number;
}
