import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

/**
 * Cross-tenant inspection browser filters. Every filter is optional and
 * structured (ids + a date range + a failed-only flag) — no free-text scan,
 * matching the other admin list surfaces. `companyId` scopes the same service
 * to a single organisation for the company-detail Inspections tab.
 */
export class ListInspectionsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsUUID()
  operatorId?: string;

  /** When true, only inspections that recorded at least one failed item. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  failedOnly?: boolean;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
