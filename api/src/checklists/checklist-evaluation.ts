import { BadRequestException } from '@nestjs/common';
import { ChecklistItemType } from './dto/checklist-item.dto';
import { ChecklistAnswerStatus } from './dto/checklist-answer.dto';

/**
 * The subset of a normalized checklist item that answer-evaluation actually
 * reads (id / label / type / requireNoteOnFail). Kept structural so the
 * service's fuller `NormalizedItem` (which also carries `createsFaultOnFail`,
 * irrelevant here) passes straight through.
 */
export interface EvaluableChecklistItem {
  id: string;
  label: string;
  type: ChecklistItemType;
  requireNoteOnFail: boolean;
}

/** One operator answer as evaluation needs it — matches ChecklistAnswerDto. */
export interface ChecklistAnswerInput {
  itemId: string;
  status?: ChecklistAnswerStatus;
  note?: string;
}

/** One evaluated item, in snapshot order — a `text` item has a `null` status. */
export interface EvaluatedAnswer {
  itemId: string;
  status: ChecklistAnswerStatus | null;
  note: string | null;
}

/**
 * Pure evaluation of an operator's answers against the snapshot they were shown
 * (extracted from ChecklistsService.validateAnswers so the rules can be unit
 * tested without a Nest app or a database): the checklist must be fully
 * answered, every answer must map to a real item, "n/a" is only allowed where
 * the item permits it, and a fail on a note-required item must carry a note.
 * Returns the answers in snapshot order. Throws BadRequestException (the same
 * `code`/`message` envelope the HTTP layer already surfaces) on any violation,
 * so behaviour is identical to the private method it replaced.
 */
export function evaluateAnswers(
  snapshot: EvaluableChecklistItem[],
  answers: ChecklistAnswerInput[],
): EvaluatedAnswer[] {
  const answerByItemId = new Map<string, ChecklistAnswerInput>();
  for (const answer of answers) {
    if (answerByItemId.has(answer.itemId)) {
      throw new BadRequestException({
        code: 'CHECKLIST_DUPLICATE_ANSWER',
        message: `Duplicate answer for item "${answer.itemId}".`,
      });
    }
    answerByItemId.set(answer.itemId, answer);
  }

  const itemById = new Map(snapshot.map((item) => [item.id, item]));
  for (const answer of answers) {
    if (!itemById.has(answer.itemId)) {
      throw new BadRequestException({
        code: 'CHECKLIST_UNKNOWN_ITEM',
        message: `Answer references unknown item "${answer.itemId}".`,
      });
    }
  }

  return snapshot.map((item) => {
    const answer = answerByItemId.get(item.id);
    if (!answer) {
      throw new BadRequestException({
        code: 'CHECKLIST_INCOMPLETE',
        message: `Checklist item "${item.label}" was not answered.`,
      });
    }
    const note = answer.note?.trim() ? answer.note.trim() : null;

    // A written-answer item: the typed response is the answer, there is no
    // pass/fail. An empty response counts as unanswered.
    if (item.type === 'text') {
      if (!note) {
        throw new BadRequestException({
          code: 'CHECKLIST_INCOMPLETE',
          message: `Checklist item "${item.label}" needs a written answer.`,
        });
      }
      return { itemId: item.id, status: null, note };
    }

    if (!answer.status) {
      throw new BadRequestException({
        code: 'CHECKLIST_INCOMPLETE',
        message: `Checklist item "${item.label}" was not answered.`,
      });
    }
    if (answer.status === 'na' && item.type !== 'pass_fail_na') {
      throw new BadRequestException({
        code: 'CHECKLIST_NA_NOT_ALLOWED',
        message: `Item "${item.label}" cannot be marked not-applicable.`,
      });
    }
    if (answer.status === 'fail' && item.requireNoteOnFail && !note) {
      throw new BadRequestException({
        code: 'CHECKLIST_NOTE_REQUIRED',
        message: `A note is required to fail "${item.label}".`,
      });
    }
    return { itemId: item.id, status: answer.status, note };
  });
}
