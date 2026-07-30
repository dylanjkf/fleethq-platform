import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class ScheduleItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsInt()
  @Min(1)
  @Max(3650)
  intervalDays!: number;
}

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  items!: ScheduleItemDto[];
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  items?: ScheduleItemDto[];
}

export class DeployTemplateDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  assetIds!: string[];
}

export class CreatePlanDto {
  @IsUUID('4')
  assetId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsInt()
  @Min(1)
  @Max(3650)
  intervalDays!: number;

  @IsOptional()
  @IsString()
  lastServiceAt?: string;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3650) intervalDays?: number;
  @IsOptional() @IsString() lastServiceAt?: string;
}
