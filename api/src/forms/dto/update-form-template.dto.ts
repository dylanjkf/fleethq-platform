import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { FormFieldDto } from './form-field.dto';
import { FORM_TARGET_CONTEXTS } from './create-form-template.dto';

/**
 * Every field optional. Passing `fields` counts as a content edit and bumps
 * the template's `version`; renaming/description/targetContext changes alone
 * do not — same rule as `UpdateChecklistTemplateDto`.
 */
export class UpdateFormTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsIn(FORM_TARGET_CONTEXTS)
  targetContext?: (typeof FORM_TARGET_CONTEXTS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  fields?: FormFieldDto[];

  /**
   * A Document id attaches reference material; an explicit `null` detaches it.
   * `@ValidateIf` for the same reason as UpdateKnowledgeArticleDto: `@IsOptional`
   * alone would treat `null` as "not provided" and make detaching impossible.
   * Changing it is not a content edit, so it does not bump `version` — the
   * questions asked haven't changed, so past submissions aren't affected.
   */
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  referenceDocumentId?: string | null;
}
