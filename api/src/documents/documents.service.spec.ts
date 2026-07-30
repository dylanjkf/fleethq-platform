import { titleFromFilename } from './documents.service';

/**
 * Bulk upload derives a title from each filename. Getting this wrong is
 * cosmetically small and practically ruinous — a 30-file import that produces
 * thirty rows called "Fatigue_Management_Policy_v3.pdf" is a library nobody can
 * read, and it has to be fixed by hand thirty times.
 */
describe('titleFromFilename', () => {
  it('drops the extension and turns separators into spaces', () => {
    expect(titleFromFilename('Fatigue_Management_Policy_v3.pdf')).toBe('Fatigue Management Policy v3');
    expect(titleFromFilename('driver-handbook-2026.PDF')).toBe('driver handbook 2026');
    expect(titleFromFilename('Chain of Responsibility.docx')).toBe('Chain of Responsibility');
  });

  it('collapses runs of separators and whitespace rather than leaving gaps', () => {
    expect(titleFromFilename('load__restraint---guide.pdf')).toBe('load restraint guide');
    expect(titleFromFilename('  spaced   out  .pdf')).toBe('spaced out');
  });

  it('leaves a name with no extension alone', () => {
    expect(titleFromFilename('README')).toBe('README');
  });

  it('does not mistake a dot inside the name for an extension boundary', () => {
    // A long trailing segment isn't an extension, so it must survive.
    expect(titleFromFilename('policy.superseded-by-v4')).toBe('policy.superseded by v4');
  });

  it('never returns an empty title, so the failure is about the file not the name', () => {
    expect(titleFromFilename('.pdf')).toBe('.pdf');
    expect(titleFromFilename('')).toBe('Untitled document');
  });

  it('truncates to the column limit', () => {
    expect(titleFromFilename(`${'a'.repeat(300)}.pdf`)).toHaveLength(200);
  });
});
