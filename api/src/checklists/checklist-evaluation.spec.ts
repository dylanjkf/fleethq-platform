import { BadRequestException } from '@nestjs/common';
import { evaluateAnswers, EvaluableChecklistItem } from './checklist-evaluation';

const item = (over: Partial<EvaluableChecklistItem> & { id: string }): EvaluableChecklistItem => ({
  label: over.id,
  type: 'pass_fail',
  requireNoteOnFail: false,
  ...over,
});

/** Runs evaluateAnswers, asserts it throws BadRequestException, returns the error `code`. */
function codeOfThrow(snapshot: EvaluableChecklistItem[], answers: Parameters<typeof evaluateAnswers>[1]): string {
  try {
    evaluateAnswers(snapshot, answers);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { code: string }).code;
  }
  throw new Error('evaluateAnswers did not throw');
}

describe('evaluateAnswers', () => {
  it('passes a pass_fail item answered "pass" (status preserved, no note)', () => {
    const result = evaluateAnswers([item({ id: 'brakes' })], [{ itemId: 'brakes', status: 'pass' }]);
    expect(result).toEqual([{ itemId: 'brakes', status: 'pass', note: null }]);
  });

  it('records a fail with its note on a note-required item', () => {
    const result = evaluateAnswers(
      [item({ id: 'lights', requireNoteOnFail: true })],
      [{ itemId: 'lights', status: 'fail', note: '  nearside out  ' }],
    );
    expect(result).toEqual([{ itemId: 'lights', status: 'fail', note: 'nearside out' }]);
  });

  it('rejects a fail on a note-required item when the note is missing/blank', () => {
    expect(codeOfThrow([item({ id: 'lights', requireNoteOnFail: true })], [{ itemId: 'lights', status: 'fail', note: '   ' }])).toBe(
      'CHECKLIST_NOTE_REQUIRED',
    );
  });

  it('rejects an incomplete checklist (a snapshot item left unanswered)', () => {
    expect(
      codeOfThrow([item({ id: 'brakes' }), item({ id: 'tyres' })], [{ itemId: 'brakes', status: 'pass' }]),
    ).toBe('CHECKLIST_INCOMPLETE');
  });

  it('rejects an answer that references an item not in the snapshot', () => {
    expect(codeOfThrow([item({ id: 'brakes' })], [{ itemId: 'ghost', status: 'pass' }])).toBe('CHECKLIST_UNKNOWN_ITEM');
  });

  it('rejects "na" on a plain pass_fail item, but allows it on pass_fail_na', () => {
    expect(codeOfThrow([item({ id: 'horn', type: 'pass_fail' })], [{ itemId: 'horn', status: 'na' }])).toBe(
      'CHECKLIST_NA_NOT_ALLOWED',
    );
    const ok = evaluateAnswers([item({ id: 'horn', type: 'pass_fail_na' })], [{ itemId: 'horn', status: 'na' }]);
    expect(ok).toEqual([{ itemId: 'horn', status: 'na', note: null }]);
  });

  it('treats a text item as answered by its note (status null); a blank text answer is incomplete', () => {
    const ok = evaluateAnswers([item({ id: 'odo', type: 'text' })], [{ itemId: 'odo', note: '123456' }]);
    expect(ok).toEqual([{ itemId: 'odo', status: null, note: '123456' }]);
    expect(codeOfThrow([item({ id: 'odo', type: 'text' })], [{ itemId: 'odo', note: '  ' }])).toBe('CHECKLIST_INCOMPLETE');
  });

  it('rejects two answers for the same item', () => {
    expect(
      codeOfThrow(
        [item({ id: 'brakes' })],
        [
          { itemId: 'brakes', status: 'pass' },
          { itemId: 'brakes', status: 'fail' },
        ],
      ),
    ).toBe('CHECKLIST_DUPLICATE_ANSWER');
  });

  it('returns evaluated answers in snapshot order regardless of answer order', () => {
    const snapshot = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const result = evaluateAnswers(snapshot, [
      { itemId: 'c', status: 'pass' },
      { itemId: 'a', status: 'fail' },
      { itemId: 'b', status: 'pass' },
    ]);
    expect(result.map((r) => r.itemId)).toEqual(['a', 'b', 'c']);
  });
});
