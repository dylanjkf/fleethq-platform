import { IsString, MaxLength, MinLength } from 'class-validator';

/** One message sent into every operator's thread at once. */
export class BroadcastMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
