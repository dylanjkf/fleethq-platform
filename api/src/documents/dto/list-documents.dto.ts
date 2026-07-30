import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListDocumentsDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  // `search` is inherited from ListQueryDto.
}
