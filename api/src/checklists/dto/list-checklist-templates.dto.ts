import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListChecklistTemplatesDto extends ListQueryDto {
  /**
   * DriverOS passes the operator's current asset; the service resolves its asset
   * category and returns the active templates that apply to it (category-specific
   * plus any category-agnostic ones). Mutually useful with `assetClass` for FleetHQ.
   */
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  assetClass?: string;
}
