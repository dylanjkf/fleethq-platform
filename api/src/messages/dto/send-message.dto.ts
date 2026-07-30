import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  /**
   * The thread's operator. Required when an office user sends; ignored when the
   * sender is themselves an operator (the server pins the thread to their own
   * Operator so one operator can't post into another's thread).
   */
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  /** Client-generated idempotency key so a DriverOS outbox replay after a lost
   *  response can't post the same message twice. */
  @IsOptional()
  @IsUUID()
  clientRequestId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
