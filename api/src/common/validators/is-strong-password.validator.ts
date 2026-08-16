import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/** Minimum length. 8 characters — a deliberate policy shape (see the function
 *  docstring): a shorter minimum length traded for a stricter composition
 *  requirement (all four classes, not two of four). */
const MIN_LENGTH = 8;

/** A tiny denylist of exact, notoriously-common passwords. Not a substitute for
 *  the composition rule — just refuses the handful that pass it trivially. */
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'iloveyou']);

/**
 * Password policy shared across every place a password is set (signup, invite,
 * reset, user create, operator link): at least 8 characters, containing ALL
 * FOUR character classes {lowercase, uppercase, digit, symbol}, and not a
 * well-known common password.
 *
 * Deliberate tradeoff (Aug 2026): the previous rule was 8 chars + any TWO of
 * the four classes. This tightens composition to require all four while keeping
 * the 8-char floor — a legitimate, common policy shape. The HaveIBeenPwned
 * breached-password check (breached-password.service.ts) runs alongside this on
 * the password-set flows it already covers and is a materially stronger
 * protection; it is intentionally unchanged by this policy.
 */
export function isStrongPassword(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < MIN_LENGTH) return false;
  if (COMMON.has(value.toLowerCase())) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes === 4;
}

export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isStrongPassword(value),
        defaultMessage: (_args: ValidationArguments) =>
          `${_args.property} must be at least ${MIN_LENGTH} characters and include all four of: lowercase, uppercase, a number, and a symbol`,
      },
    });
  };
}
