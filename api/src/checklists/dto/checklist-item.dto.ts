import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// `text` is a written-answer item: the operator types a response instead of
// marking pass/fail (e.g. "Odometer reading", "Notes for the workshop").
export const CHECKLIST_ITEM_TYPES = ['pass_fail', 'pass_fail_na', 'text'] as const;
export type ChecklistItemType = (typeof CHECKLIST_ITEM_TYPES)[number];

/**
 * One data-driven checklist item. A whole checklist definition is an array of
 * these, stored as JSON on `ChecklistTemplate.items` and snapshotted verbatim
 * onto every submission. `id` is a stable, client-assigned identifier that
 * answers reference — it must never be reused across different items, so a
 * completed submission's answers stay meaningful even after the template is
 * edited. This is deliberately NOT the full Universal Forms builder; the only
 * "branching" is the two boolean follow-ups below.
 */
export class ChecklistItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @IsIn(CHECKLIST_ITEM_TYPES)
  type!: ChecklistItemType;

  /** If the item is answered "fail", a note becomes mandatory (enforced on submit). */
  @IsOptional()
  @IsBoolean()
  requireNoteOnFail?: boolean;

  /** If the item is answered "fail", submitting spawns a workshop MaintenanceJob. */
  @IsOptional()
  @IsBoolean()
  createsFaultOnFail?: boolean;
}
