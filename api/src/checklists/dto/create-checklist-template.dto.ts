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

export class CreateChecklistTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /**
   * Which asset category this checklist is for, by key (a built-in like LAND, or
   * a company's own category). Omit (or 'ANY') to apply to every category.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appliesToAssetClass?: string;

  /**
   * Specific assets this checklist is assigned to, on top of the class rule
   * above — the persistent "assign once, applies every day" link. Omit for none.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  assignedAssetIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items!: ChecklistItemDto[];
}
