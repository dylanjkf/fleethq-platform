import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional } from 'class-validator';

/**
 * Deliberately does NOT `@ValidateNested` its rows against the target entity
 * DTO here — a single malformed row must never reject the whole batch with a
 * generic 400. Each row is validated individually inside ImportsService so a
 * per-row pass/fail can be reported (01-Product/Onboarding_Import.md: "no
 * row's failure prevents any other valid row... from being created").
 */
export class ImportRowsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  rows!: Record<string, unknown>[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
