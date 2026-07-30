import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ChecklistItemDto } from './checklist-item.dto';

/**
 * Every field optional. Passing `items` (or a changed `appliesToAssetClass`)
 * counts as a content edit and bumps the template's `version`; renaming alone
 * does not, so existing submissions' recorded version stays meaningful.
 */
export class UpdateChecklistTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  appliesToAssetClass?: string;

  /**
   * Replace the set of specific assets this checklist is assigned to. Omit to
   * leave assignments unchanged; pass `[]` to clear them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  assignedAssetIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items?: ChecklistItemDto[];
}
