import { registerDecorator, ValidationOptions } from 'class-validator';

/** Per-position weighting factors in the Australian Business Register's own ABN checksum algorithm. */
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/**
 * Validates an 11-digit Australian Business Number using the ABR's published
 * checksum (subtract 1 from the first digit, multiply each digit by its
 * weight, sum, and the result must be divisible by 89) — catches a typo'd or
 * fabricated ABN at intake rather than accepting any 11-digit string.
 * Ignores spaces (ABNs are conventionally displayed as "51 824 753 556").
 */
export function isValidAbn(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;

  const sum = digits
    .split('')
    .map(Number)
    .reduce((total, digit, i) => total + (i === 0 ? digit - 1 : digit) * WEIGHTS[i], 0);

  return sum % 89 === 0;
}

export function IsAbn(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAbn',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isValidAbn(value),
        defaultMessage: () => `${propertyName} must be a valid 11-digit Australian Business Number`,
      },
    });
  };
}
