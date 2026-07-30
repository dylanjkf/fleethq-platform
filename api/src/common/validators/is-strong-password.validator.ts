import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/** Minimum length. Kept at 8 (the existing floor) so it never weakens an
 *  existing rule, while adding a composition requirement on top. */
const MIN_LENGTH = 8;

/** A tiny denylist of exact, notoriously-common passwords. Not a substitute for
 *  the composition rule — just refuses the handful that pass it trivially. */
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'iloveyou']);

/**
 * Password policy shared across every place a password is set (signup, invite,
 * reset, user create, operator link): at least 8 characters, drawing on at
 * least two of {lowercase, uppercase, digit, symbol}, and not a well-known
 * common password. Deliberately modest — enough to stop the weakest choices
 * without frustrating a legitimate strong passphrase.
 */
export function isStrongPassword(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < MIN_LENGTH) return false;
  if (COMMON.has(value.toLowerCase())) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2;
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
          `${_args.property} must be at least ${MIN_LENGTH} characters and combine at least two of: lowercase, uppercase, numbers, symbols`,
      },
    });
  };
}
