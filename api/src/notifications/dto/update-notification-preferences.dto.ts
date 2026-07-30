import { IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { NOTIFICATION_TYPE_KEYS } from '../notification-types';

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  digestOnly?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(NOTIFICATION_TYPE_KEYS, { each: true })
  mutedTypes?: string[];
}
