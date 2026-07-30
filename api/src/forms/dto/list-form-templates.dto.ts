import { IsIn, IsOptional } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';
import { FORM_TARGET_CONTEXTS } from './create-form-template.dto';

export class ListFormTemplatesDto extends ListQueryDto {
  /** DriverOS asks for DRIVER-or-BOTH-targeted templates; FleetHQ asks for OFFICE-or-BOTH, or omits this to see everything. */
  @IsOptional()
  @IsIn(FORM_TARGET_CONTEXTS)
  targetContext?: (typeof FORM_TARGET_CONTEXTS)[number];
}
