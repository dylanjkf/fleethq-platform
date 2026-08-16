import { isStrongPassword } from './is-strong-password.validator';

describe('isStrongPassword (8+ chars, all four character classes)', () => {
  it('accepts an 8-character password containing all four classes', () => {
    expect(isStrongPassword('Abcd12!x')).toBe(true); // exactly 8: upper+lower+digit+symbol
    expect(isStrongPassword('Test-1234pass!')).toBe(true);
  });

  it('rejects a 7-character password regardless of composition', () => {
    // Has all four classes but is one char too short.
    expect(isStrongPassword('Ab1!xyz')).toBe(false);
    expect(isStrongPassword('short7')).toBe(false);
  });

  it('rejects a password missing any one class even if it is long', () => {
    expect(isStrongPassword('abcdefgh1234!!!!')).toBe(false); // no uppercase
    expect(isStrongPassword('ABCDEFGH1234!!!!')).toBe(false); // no lowercase
    expect(isStrongPassword('Abcdefghijklmnop')).toBe(false); // no digit, no symbol
    expect(isStrongPassword('Abcdefghijkl1234')).toBe(false); // no symbol
    expect(isStrongPassword('Abcd!@#$%^&*()_+')).toBe(false); // no digit
  });

  it('rejects passwords with only two or three classes (old rule would have passed some)', () => {
    expect(isStrongPassword('test-password-123')).toBe(false); // lower+digit+symbol, no upper
    expect(isStrongPassword('Abcd1234')).toBe(false); // upper+lower+digit, no symbol
    expect(isStrongPassword('alllowercase')).toBe(false);
    expect(isStrongPassword('12345678')).toBe(false);
  });

  it('rejects well-known common passwords', () => {
    expect(isStrongPassword('password123')).toBe(false);
    expect(isStrongPassword('Password123'.toLowerCase())).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isStrongPassword(undefined)).toBe(false);
    expect(isStrongPassword(12345678)).toBe(false);
  });
});
