import { IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListFormSubmissionsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;
}
