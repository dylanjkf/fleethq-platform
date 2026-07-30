import { IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListChecklistSubmissionsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
