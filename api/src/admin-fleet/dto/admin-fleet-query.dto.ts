import { IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

/**
 * Cross-tenant fleet list query. Adds an optional `companyId` so the same
 * endpoints power both the global Fleet view and the per-organisation
 * Vehicles / Drivers tabs on the company detail page.
 */
export class AdminFleetQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;
}
