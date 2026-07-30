import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One answer to a form field, keyed by the field's stable `id`. `value`'s
 * real shape depends on the field's type (a string, a number, a string array
 * for multi_select, or an Asset/Operator id) — validated against the
 * template snapshot in `FormsService`, the same "validate in the service
 * against sibling data, not in the DTO" pattern `ChecklistAnswerDto`'s
 * status/item-type check uses. An unanswered optional (or conditionally
 * hidden) field simply has no entry here.
 */
export class FormAnswerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  fieldId!: string;

  // No type-specific decorator on purpose — the valid shape depends on the
  // field's type, validated in FormsService against the template snapshot.
  // `@IsOptional()` only exists so the global ValidationPipe's `whitelist`
  // recognizes this property at all (an undecorated property is otherwise
  // stripped/rejected outright, regardless of its actual value).
  @IsOptional()
  value?: unknown;
}
