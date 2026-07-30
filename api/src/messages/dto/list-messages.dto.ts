import { IsOptional, IsUUID } from 'class-validator';

export class ListMessagesDto {
  /**
   * Which operator's thread to read. Required for office users; overridden to
   * the caller's own Operator when the caller is an operator, so an operator can
   * only ever read their own thread.
   */
  @IsOptional()
  @IsUUID()
  operatorId?: string;
}
