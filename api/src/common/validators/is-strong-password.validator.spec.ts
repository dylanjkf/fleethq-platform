import { isStrongPassword } from './is-strong-password.validator';

describe('isStrongPassword', () => {
  it('accepts a password of length >= 8 with two or more character classes', () => {
    expect(isStrongPassword('test-password-123')).toBe(true); // lower + digit + symbol
    expect(isStrongPassword('Abcd1234')).toBe(true); // upper + lower + digit
    expect(isStrongPassword('correcthorse9')).toBe(true); // lower + digit
  });

  it('rejects too-short passwords', () => {
    expect(isStrongPassword('Ab1!')).toBe(false);
    expect(isStrongPassword('short7')).toBe(false);
  });

  it('rejects single-character-class passwords', () => {
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
