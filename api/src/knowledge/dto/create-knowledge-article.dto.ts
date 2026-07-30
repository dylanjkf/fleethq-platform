import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateKnowledgeArticleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  /**
   * Markdown body. Optional, but an article must have *something* — either a
   * body or an imported document. Enforced in the service, which can say which
   * of the two is missing, rather than by a cross-field validator that can only
   * report a generic failure.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  body?: string;

  /**
   * An existing Document (a policy/SOP PDF) to present as this article. The file
   * is referenced, not copied — one upload, usable in the document library and
   * the knowledge base at once.
   */
  @IsOptional()
  @IsUUID()
  sourceDocumentId?: string;

  /** Defaults to 'draft' — an article isn't visible to plain viewers until published. */
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}
