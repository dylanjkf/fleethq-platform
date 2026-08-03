import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export const MAINTENANCE_STATUSES = ['OPEN', 'IN_PROGRESS', 'PARTS_PENDING', 'COMPLETE'] as const;
export type MaintenanceStatusFilter = (typeof MAINTENANCE_STATUSES)[number];

/**
 * Cross-tenant maintenance/defect browser filters. Structured only (ids +
 * status + date range); `companyId` scopes the same service to a single
 * organisation for the company-detail Maintenance tab.
 */
export class ListMaintenanceDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsIn(MAINTENANCE_STATUSES)
  status?: MaintenanceStatusFilter;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
