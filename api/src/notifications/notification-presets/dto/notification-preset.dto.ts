import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { NOTIFICATION_TYPE_KEYS } from '../../notification-types';

export class CreateNotificationPresetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsBoolean()
  digestOnly?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(NOTIFICATION_TYPE_KEYS, { each: true })
  mutedTypes?: string[];
}

export class UpdateNotificationPresetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsBoolean() digestOnly?: boolean;
  @IsOptional() @IsArray() @IsIn(NOTIFICATION_TYPE_KEYS, { each: true }) mutedTypes?: string[];
}

export class DeployNotificationPresetDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  userIds!: string[];
}
