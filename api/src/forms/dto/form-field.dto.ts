import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const FORM_FIELD_TYPES = [
  'text',
  'number',
  'single_select',
  'multi_select',
  'date',
  'asset_ref',
  'operator_ref',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

const SELECT_TYPES: FormFieldType[] = ['single_select', 'multi_select'];

/**
 * One data-driven form field. A whole form definition is an array of these,
 * stored as JSON on `FormTemplate.fields` and snapshotted verbatim onto every
 * submission — same "id is a stable, client-assigned identifier" and
 * "snapshot, don't rewrite history" rules as `ChecklistItemDto`.
 *
 * `showIfFieldId`/`showIfValue` are this slice's entire "conditional logic"
 * (Universal_Forms.md's "show/hide fields"): a single-level condition, not a
 * multi-branch tree. Deliberately scoped down — see the doc's own
 * Implementation notes.
 */
export class FormFieldDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @IsIn(FORM_FIELD_TYPES)
  type!: FormFieldType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  /** Required (and non-empty) when `type` is single_select/multi_select — enforced in the service, not here, since it depends on another field. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  options?: string[];

  /** This field only shows when the field with this id currently holds `showIfValue`. Must reference a field declared earlier in the array. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  showIfFieldId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  showIfValue?: string;
}

export function isSelectType(type: FormFieldType): boolean {
  return SELECT_TYPES.includes(type);
}
