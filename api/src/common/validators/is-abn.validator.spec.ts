import { isValidAbn } from './is-abn.validator';

describe('isValidAbn', () => {
  it('accepts a valid ABN', () => {
    expect(isValidAbn('53004085616')).toBe(true);
  });

  it('accepts a valid ABN formatted with the conventional spacing', () => {
    expect(isValidAbn('53 004 085 616')).toBe(true);
  });

  it('rejects an ABN with a bad checksum', () => {
    expect(isValidAbn('53004085617')).toBe(false);
  });

  it('rejects the wrong number of digits', () => {
    expect(isValidAbn('5300408561')).toBe(false);
    expect(isValidAbn('530040856166')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isValidAbn('5300408561x')).toBe(false);
    expect(isValidAbn('not an abn')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidAbn(undefined)).toBe(false);
    expect(isValidAbn(53004085616)).toBe(false);
  });
});
