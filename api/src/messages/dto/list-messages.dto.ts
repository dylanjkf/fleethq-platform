import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ListQueryDto, MAX_PAGE_SIZE } from '../../common/dto/list-query.dto';

export class ListMessagesDto extends ListQueryDto {
  /**
   * Which operator's thread to read. Required for office users; overridden to
   * the caller's own Operator when the caller is an operator, so an operator can
   * only ever read their own thread.
   */
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  /**
   * A chat thread shows a wide recent window by default (the whole visible
   * conversation), so redeclare the shared page size with a 200 default instead
   * of the generic 25 — page > 1 loads progressively older history. The 200 hard
   * cap (MAX_PAGE_SIZE) still applies, keeping the read bounded on a hot table.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = MAX_PAGE_SIZE;
}
