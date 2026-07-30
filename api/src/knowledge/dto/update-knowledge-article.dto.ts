import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class UpdateKnowledgeArticleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body?: string;

  /**
   * A Document id links one; an explicit `null` unlinks it. `@ValidateIf` rather
   * than `@IsOptional` because `@IsOptional` also skips validation for `null`,
   * which would make "unlink" indistinguishable from "leave alone" — here the
   * two mean different things.
   */
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  sourceDocumentId?: string | null;

  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}
