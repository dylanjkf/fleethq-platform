import { IsIn, IsOptional } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export const ORGANISATION_STATUS_FILTERS = ['all', 'active', 'suspended', 'archived'] as const;
export type OrganisationStatusFilter = (typeof ORGANISATION_STATUS_FILTERS)[number];

/** Reuses the app-wide pagination/search shape; adds the organisation lifecycle filter. */
export class AdminOrganisationsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(ORGANISATION_STATUS_FILTERS)
  status?: OrganisationStatusFilter = 'active';
}
