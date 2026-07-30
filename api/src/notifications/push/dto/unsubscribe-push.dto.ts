import { IsString, MaxLength, MinLength } from 'class-validator';

export class UnsubscribePushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  endpoint!: string;
}
