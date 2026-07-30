import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `files` is deliberately NOT `@ValidateNested` against CreateDocumentDto here.
 * Same reasoning as ImportRowsDto: one unreadable file out of thirty must not
 * reject the whole batch with a generic 400. Each file is validated
 * individually inside DocumentsService so a per-file pass/fail can be reported
 * (01-Product/Onboarding_Import.md: "no row's failure prevents any other valid
 * row... from being created").
 *
 * There is no `dryRun` counterpart, unlike the CSV imports. A dry run exists to
 * let someone check a batch *before paying the cost of committing it* — but the
 * expensive part of a file upload is transferring the bytes, and a dry run
 * transfers them too. It would cost the user exactly as much as the real thing
 * and tell them almost nothing extra, so it isn't offered.
 *
 * The batch size cap is small on purpose: uploads arrive as base64 over JSON
 * against a 15 MB body limit (main.ts), so "upload 60 PDFs at once" is honoured
 * by the client sending several bounded batches, not by one enormous request.
 */
export class BulkUploadDocumentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  files!: Record<string, unknown>[];

  /** Applied to any file that doesn't carry its own category. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  /**
   * Also create a Knowledge Base article per uploaded document, referencing it —
   * how a company gets a folder of SOP PDFs into the knowledge base in one
   * action. Articles are created as drafts, so nothing goes live unreviewed.
   * Requires `knowledge:create` in addition to `documents:create`.
   */
  @IsOptional()
  @IsBoolean()
  publishToKnowledgeBase?: boolean;
}
