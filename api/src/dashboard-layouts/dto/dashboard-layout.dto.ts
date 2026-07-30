import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { DASHBOARD_WIDGET_KEYS } from '../dashboard-widgets';

export class WidgetSlotDto {
  @IsIn(DASHBOARD_WIDGET_KEYS)
  key!: string;

  @IsBoolean()
  visible!: boolean;
}

export class SetLayoutDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WidgetSlotDto)
  widgets!: WidgetSlotDto[];
}

export class CreatePresetDto {
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
  @Type(() => WidgetSlotDto)
  widgets!: WidgetSlotDto[];
}

export class UpdatePresetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => WidgetSlotDto)
  widgets?: WidgetSlotDto[];
}

export class DeployPresetDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  userIds!: string[];
}
