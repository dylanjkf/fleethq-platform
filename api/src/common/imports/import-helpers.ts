import { ValidationError } from 'class-validator';

/**
 * Shared per-row bulk-import result shape (01-Product/Onboarding_Import.md: "no
 * row's failure prevents any other valid row... from being created"). Lives
 * outside the `imports` module so any feature can reuse it for its own
 * CSV-import endpoint (e.g. Dispatch stop import) without depending on
 * `imports` — bulk-input is a pattern, not a capability owned by one module.
 */
export interface ImportRowResult {
  index: number;
  valid: boolean;
  created: boolean;
  errors: string[];
  id?: string;
}

export interface ImportResult {
  total: number;
  validCount: number;
  invalidCount: number;
  createdCount: number;
  dryRun: boolean;
  rows: ImportRowResult[];
}

export function summarizeImportRows(total: number, dryRun: boolean, rows: ImportRowResult[]): ImportResult {
  const validCount = rows.filter((r) => r.valid).length;
  const createdCount = rows.filter((r) => r.created).length;
  return { total, validCount, invalidCount: total - validCount, createdCount, dryRun, rows };
}

export function flattenValidationErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

export function describeImportRowError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { message?: string } }).response;
    if (response?.message) return response.message;
  }
  return 'Could not create this row.';
}
