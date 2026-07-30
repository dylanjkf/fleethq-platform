import { Injectable } from '@nestjs/common';
import { IntegrationTransform } from '@prisma/client';

type TransformConfig = Record<string, unknown> | null | undefined;

/**
 * Small, explicitly non-exhaustive fixed conversion table (lb<->kg, mi<->km —
 * the task's documented minimum). An unsupported pair returns the raw value
 * unconverted rather than guessing at a factor.
 */
const UNIT_CONVERSION_FACTORS: Record<string, number> = {
  'lb->kg': 0.45359237,
  'kg->lb': 1 / 0.45359237,
  'mi->km': 1.609344,
  'km->mi': 1 / 1.609344,
};

/**
 * Applies one IntegrationTransform to one raw external value (Universal Data
 * Mapping Engine — 10-Integrations/Integration_Hub.md). Pure and
 * side-effect-free so IntegrationMappingEngine can call it per field per row
 * without any I/O.
 */
@Injectable()
export class IntegrationTransformService {
  apply(transform: IntegrationTransform, rawValue: unknown, config: TransformConfig): unknown {
    switch (transform) {
      case 'NONE':
        return rawValue;
      case 'UPPERCASE':
        return typeof rawValue === 'string' ? rawValue.toUpperCase() : rawValue;
      case 'LOWERCASE':
        return typeof rawValue === 'string' ? rawValue.toLowerCase() : rawValue;
      case 'TRIM':
        return typeof rawValue === 'string' ? rawValue.trim() : rawValue;
      case 'DATE_FORMAT':
        return this.applyDateFormat(rawValue, config);
      case 'UNIT_CONVERSION':
        return this.applyUnitConversion(rawValue, config);
      case 'DEFAULT_VALUE':
        return this.isEmpty(rawValue) ? (config?.value ?? null) : rawValue;
      case 'LOOKUP_TABLE':
        return this.applyLookup(rawValue, config);
      default:
        return rawValue;
    }
  }

  private isEmpty(value: unknown): boolean {
    return value === null || value === undefined || value === '';
  }

  /**
   * Hand-rolled, no date-library dependency (house rule: this codebase has
   * zero date-library deps). Supports the three formats the task requires —
   * DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD — normalising to ISO (YYYY-MM-DD) since
   * every FleetHQ date field accepts `@IsDateString`. Anything that doesn't
   * match the configured format is returned unparsed so the caller's
   * downstream validation flags it, rather than silently guessing.
   */
  private applyDateFormat(rawValue: unknown, config: TransformConfig): unknown {
    if (typeof rawValue !== 'string' || !rawValue.trim()) return rawValue;
    const format = typeof config?.format === 'string' ? config.format : 'YYYY-MM-DD';
    const value = rawValue.trim();
    const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

    let day: number | undefined;
    let month: number | undefined;
    let year: number | undefined;
    if (format === 'DD/MM/YYYY' && slash) {
      [day, month, year] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
    } else if (format === 'MM/DD/YYYY' && slash) {
      [month, day, year] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
    } else if (format === 'YYYY-MM-DD' && iso) {
      [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    } else {
      return rawValue;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return rawValue;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  private applyUnitConversion(rawValue: unknown, config: TransformConfig): unknown {
    const from = typeof config?.from === 'string' ? config.from.toLowerCase() : undefined;
    const to = typeof config?.to === 'string' ? config.to.toLowerCase() : undefined;
    const numeric = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' ? Number(rawValue) : NaN;
    if (!from || !to || Number.isNaN(numeric)) return rawValue;
    if (from === to) return numeric;
    const factor = UNIT_CONVERSION_FACTORS[`${from}->${to}`];
    return factor === undefined ? rawValue : numeric * factor;
  }

  private applyLookup(rawValue: unknown, config: TransformConfig): unknown {
    const entries = (config?.entries as Record<string, unknown> | undefined) ?? {};
    const key = typeof rawValue === 'string' ? rawValue : String(rawValue);
    if (Object.prototype.hasOwnProperty.call(entries, key)) return entries[key];
    return config?.default ?? rawValue;
  }
}
