import { Type } from 'class-transformer';
import { IsDefined, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

class PushSubscriptionKeysDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  p256dh!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  auth!: string;
}

/** Matches the browser's PushSubscription.toJSON() shape exactly. */
export class SubscribePushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  endpoint!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;
}
