import { Prisma } from '@prisma/client';

/** The six built-in searchable keys (see BarcodeSearchableField doc comment on
 *  the schema) and the StopParcel column each maps to. A non-custom
 *  searchable field's `key` must be one of these — everything else has to go
 *  through `isCustom` + `customFields`. */
export const BUILTIN_FIELD_COLUMNS: Record<string, keyof Prisma.StopParcelUncheckedCreateInput> = {
  reference: 'reference',
  trackingNumber: 'trackingNumber',
  consignmentNumber: 'consignmentNumber',
  manifestNumber: 'manifestNumber',
  internalId: 'internalId',
  customerReference: 'customerReference',
};

/** The bit of a searchable field the matcher reads: its key and whether it's a
 *  custom (customFields JSON) field vs. a built-in StopParcel column. */
export interface SearchableFieldKey {
  key: string;
  isCustom: boolean;
}

/**
 * Decode a scanned string into named fields. Attempts JSON, then
 * `key:value;key2:value2` pairs; falls back to the raw string under the
 * `'scan'` key either way, since a mapping might target `sourceField: 'scan'`
 * to mean "the whole payload" regardless of whether it also happened to parse
 * into named fields. Pure — extracted from BarcodeService so the decode rules
 * can be unit tested without a Nest app or a database.
 */
export function decodeScan(scannedValue: string): Record<string, string> {
  const result: Record<string, string> = { scan: scannedValue };
  try {
    const parsed: unknown = JSON.parse(scannedValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) result[k] = String(v);
      return result;
    }
  } catch {
    // not JSON — fall through to key:value pairs
  }
  if (scannedValue.includes(':')) {
    const pairs = scannedValue
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    if (pairs.length > 0 && pairs.every((p) => p.includes(':'))) {
      for (const pair of pairs) applyKeyValuePair(result, pair);
    }
  }
  return result;
}

function applyKeyValuePair(result: Record<string, string>, pair: string): void {
  const idx = pair.indexOf(':');
  const key = pair.slice(0, idx).trim();
  const value = pair.slice(idx + 1).trim();
  if (key) result[key] = value;
}

/** The Prisma `where` fragment that matches one searchable field to `value`:
 *  a custom field keys into the customFields JSON, a built-in field into its
 *  StopParcel column. Returns null for a non-custom key with no known column. */
function columnCondition(field: SearchableFieldKey, value: string): Prisma.StopParcelWhereInput | null {
  if (field.isCustom) {
    return { customFields: { path: [field.key], equals: value } };
  }
  const column = BUILTIN_FIELD_COLUMNS[field.key];
  return column ? ({ [column]: value } as Prisma.StopParcelWhereInput) : null;
}

/**
 * Build the two candidate match-condition sets from a decoded scan. `targetedOr`
 * matches each searchable field to its OWN decoded value (a barcode that encodes
 * its own trackingNumber shouldn't be matched by accidentally equalling some
 * other column) — used by ENCODED_BARCODE and the HYBRID first pass. `rawOr`
 * matches every searchable field against the whole raw scanned string — used by
 * DATABASE_LOOKUP and the HYBRID fallback. Pure: the DB query that consumes
 * these OR lists stays in the service.
 */
export function buildMatchConditions(
  searchableFields: SearchableFieldKey[],
  decoded: Record<string, string>,
  rawValue: string,
): { targetedOr: Prisma.StopParcelWhereInput[]; rawOr: Prisma.StopParcelWhereInput[] } {
  const targetedOr = searchableFields
    .map((f) => (decoded[f.key] !== undefined ? columnCondition(f, decoded[f.key]) : null))
    .filter((c): c is Prisma.StopParcelWhereInput => c !== null);
  const rawOr = searchableFields
    .map((f) => columnCondition(f, rawValue))
    .filter((c): c is Prisma.StopParcelWhereInput => c !== null);
  return { targetedOr, rawOr };
}
