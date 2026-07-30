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
  ValidateNested,
} from 'class-validator';
import { FormFieldDto } from './form-field.dto';

export const FORM_TARGET_CONTEXTS = ['DRIVER', 'OFFICE', 'BOTH'] as const;

export class CreateFormTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Which app(s) this form is assigned to. Defaults to BOTH if omitted. */
  @IsOptional()
  @IsIn(FORM_TARGET_CONTEXTS)
  targetContext?: (typeof FORM_TARGET_CONTEXTS)[number];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  fields!: FormFieldDto[];

  /**
   * An existing Document to show alongside the form as reference material — the
   * original paper version, a work instruction, a hazard sheet. Referenced from
   * the document library, so it isn't uploaded again per form.
   */
  @IsOptional()
  @IsUUID()
  referenceDocumentId?: string;
}
