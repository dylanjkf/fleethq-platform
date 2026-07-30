import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const CHECKLIST_ANSWER_STATUSES = ['pass', 'fail', 'na'] as const;
export type ChecklistAnswerStatus = (typeof CHECKLIST_ANSWER_STATUSES)[number];

/** One operator answer to a checklist item, keyed by the item's stable `id`. */
export class ChecklistAnswerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  itemId!: string;

  /**
   * Pass/fail/na for a `pass_fail`(`_na`) item. Optional because a `text` item
   * carries its written answer in `note` and has no pass/fail status; the server
   * validates the right shape per item type on submit.
   */
  @IsOptional()
  @IsIn(CHECKLIST_ANSWER_STATUSES)
  status?: ChecklistAnswerStatus;

  /** Fail-explanation on a pass/fail item, or the written answer on a `text` item. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
