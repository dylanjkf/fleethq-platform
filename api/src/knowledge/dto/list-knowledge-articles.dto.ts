import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListKnowledgeArticlesDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  // `search` is inherited from ListQueryDto.

  /** Narrow to one status. Drafts are only returned to authors (knowledge:create). */
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}
