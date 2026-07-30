import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

// Sane bounds: minutes in a value that can't exceed a week, so a fat-fingered
// entry can't create an un-triggerable or nonsensical rule.
const MAX_MIN = 7 * 24 * 60;

export class CreateFatigueRuleSetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsInt() @Min(1) @Max(MAX_MIN) maxWork24hMin!: number;
  @IsInt() @Min(0) @Max(MAX_MIN) minRest24hMin!: number;
  @IsInt() @Min(1) @Max(MAX_MIN) maxWork7dMin!: number;
  @IsInt() @Min(0) @Max(MAX_MIN) minRest7dMin!: number;
  @IsInt() @Min(0) @Max(24 * 60) approachingBufferMin!: number;

  @IsOptional() @IsInt() @Min(1) @Max(60) lookbackDays?: number;

  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateFatigueRuleSetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_MIN) maxWork24hMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MIN) minRest24hMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_MIN) maxWork7dMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MIN) minRest7dMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(24 * 60) approachingBufferMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) lookbackDays?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

/** Deploy a saved rule set to operators and/or make it the company default. */
export class DeployFatigueRuleSetDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  operatorIds?: string[];

  @IsOptional() @IsBoolean() setDefault?: boolean;
}
