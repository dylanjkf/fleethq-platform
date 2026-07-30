import { IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListComplianceDocumentsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsUUID()
  operatorId?: string;
}
