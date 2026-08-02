import { AuditService } from './audit.service';

/**
 * Unit coverage for CSV formula/injection neutralisation in the audit-log
 * export (FIX 4 / OWASP CSV injection). `csvCell` is private but is the exact
 * boundary the guidance targets, so it's exercised directly. The same helper
 * backs every cell of the export, so any admin audit CSV export sharing it is
 * covered automatically.
 */
describe('AuditService.csvCell (CSV injection neutralisation)', () => {
  const service = new AuditService({} as never, {} as never, {} as never);
  const csvCell = (value: string): string =>
    (service as unknown as { csvCell(value: string): string }).csvCell(value);

  it.each(['=', '+', '-', '@'])('prefixes a single quote onto a cell starting with "%s"', (trigger) => {
    const out = csvCell(`${trigger}cmd|' /C calc'!A0`);
    expect(out.startsWith(`'${trigger}`)).toBe(true);
  });

  it('neutralises a leading tab and carriage return (spreadsheets strip these before evaluating)', () => {
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    // A leading \r also triggers RFC-4180 quoting; the neutraliser runs first.
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('leaves an ordinary value untouched', () => {
    expect(csvCell('login_succeeded')).toBe('login_succeeded');
    expect(csvCell('')).toBe('');
  });

  it('preserves the original value verbatim after the neutralising quote', () => {
    const value = '=HYPERLINK("http://evil","click")';
    expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
  });

  it('still applies RFC-4180 quoting for commas/quotes/newlines on a non-triggering cell', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });
});
