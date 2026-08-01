import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BarcodeFieldTarget, BarcodeScanMode, BarcodeScanOutcome, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_PAGE_SIZE } from '../common/dto/list-query.dto';
import { UpdateBarcodeScanConfigDto } from './dto/barcode-config.dto';
import { CreateSearchableFieldDto, UpdateSearchableFieldDto } from './dto/searchable-field.dto';
import { CreateFieldMappingDto, UpdateFieldMappingDto } from './dto/field-mapping.dto';
import { CreateFromScanDto, ScanDto } from './dto/scan.dto';
import { BUILTIN_FIELD_COLUMNS, buildMatchConditions, decodeScan } from './barcode-matching';

const DEFAULT_SEARCHABLE_FIELDS: { key: string; label: string }[] = [
  { key: 'reference', label: 'Barcode' },
  { key: 'trackingNumber', label: 'Tracking Number' },
  { key: 'consignmentNumber', label: 'Consignment Number' },
  { key: 'manifestNumber', label: 'Manifest Number' },
  { key: 'internalId', label: 'Internal ID' },
  { key: 'customerReference', label: 'Customer Reference' },
];

/** BarcodeFieldTarget -> the camelCase key it's surfaced under in a scan
 *  response's `populatedFields` (CUSTOMER and CUSTOM_FIELD are handled
 *  specially, see buildPopulatedFields/setPopulatedField below). */
const TARGET_TO_RESPONSE_KEY: Partial<Record<BarcodeFieldTarget, string>> = {
  TRACKING_NUMBER: 'trackingNumber',
  CONSIGNMENT_NUMBER: 'consignmentNumber',
  MANIFEST_NUMBER: 'manifestNumber',
  INTERNAL_ID: 'internalId',
  CUSTOMER_REFERENCE: 'customerReference',
  DELIVERY_ADDRESS: 'deliveryAddress',
  CONTACT: 'contactName',
  DELIVERY_NOTES: 'deliveryNotes',
  SERVICE_TYPE: 'serviceType',
  PARCEL_COUNT: 'parcelCount',
  WEIGHT: 'weightKg',
  CUBIC: 'cubicM3',
  DANGEROUS_GOODS: 'dangerousGoods',
};

/** Same targets, but as the StopParcel column to read FROM when a mapping's
 *  `isDatabaseLookup` pulls a value off an already-matched parcel. Identical
 *  key set to TARGET_TO_RESPONSE_KEY today (every target that isn't
 *  CUSTOMER/CUSTOM_FIELD names a real StopParcel column with the same
 *  camelCase name) — kept as a separate constant since the two concepts
 *  (response shape vs. source column) are free to diverge later. */
const TARGET_TO_STOPPARCEL_COLUMN = TARGET_TO_RESPONSE_KEY;

type MatchedParcel = Prisma.StopParcelGetPayload<{
  include: { stop: { include: { job: true; customer: true } } };
}>;

interface PopulatedFields {
  [key: string]: unknown;
  customFields?: Record<string, unknown>;
  customer?: { id?: string; name: string };
}

/**
 * Configurable barcode scanning (01-Product/Barcode_Scanning.md): per-company
 * searchable fields + field mappings decide what a scan searches and what it
 * populates; BarcodeScanConfig decides the overall mode/behaviour.
 * Every mutation is scoped through `withTenant` (RLS), matching
 * dispatch/parcels.service.ts.
 */
@Injectable()
export class BarcodeService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Config (auto-created + seeded on first read) ----

  async getConfig(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const scanConfig = await this.ensureConfig(tx, companyId);
      const searchableFields = await tx.barcodeSearchableField.findMany({
        where: { companyId, archivedAt: null },
        orderBy: { order: 'asc' },
      });
      const fieldMappings = await tx.barcodeFieldMapping.findMany({
        where: { companyId, archivedAt: null },
        orderBy: { order: 'asc' },
      });
      return { scanConfig, searchableFields, fieldMappings };
    });
  }

  async updateConfig(companyId: string, dto: UpdateBarcodeScanConfigDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.ensureConfig(tx, companyId);
      return tx.barcodeScanConfig.update({
        where: { companyId },
        data: {
          scanMode: dto.scanMode,
          allowManualEntry: dto.allowManualEntry,
          blockOnMissingFields: dto.blockOnMissingFields,
          requiredFields: dto.requiredFields,
        },
      });
    });
  }

  /** Upsert-on-read: a company never sees a missing/broken config, and gets
   *  the 6 built-in searchable fields pre-seeded the first time anyone asks. */
  private async ensureConfig(tx: Prisma.TransactionClient, companyId: string) {
    let config = await tx.barcodeScanConfig.findUnique({ where: { companyId } });
    if (!config) {
      config = await tx.barcodeScanConfig.create({
        data: { companyId, scanMode: 'DATABASE_LOOKUP', allowManualEntry: true, blockOnMissingFields: false, requiredFields: [] },
      });
    }
    const existingFieldCount = await tx.barcodeSearchableField.count({ where: { companyId } });
    if (existingFieldCount === 0) {
      await tx.barcodeSearchableField.createMany({
        data: DEFAULT_SEARCHABLE_FIELDS.map((f, order) => ({ companyId, key: f.key, label: f.label, isCustom: false, order })),
      });
    }
    return config;
  }

  // ---- Searchable fields ----

  async createSearchableField(companyId: string, dto: CreateSearchableFieldDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const isCustom = dto.isCustom ?? false;
      if (!isCustom && !BUILTIN_FIELD_COLUMNS[dto.key]) {
        throw new BadRequestException({
          code: 'BARCODE_FIELD_UNKNOWN_BUILTIN',
          message: `'${dto.key}' isn't a built-in StopParcel field — mark it isCustom to key into customFields instead.`,
        });
      }
      const existing = await tx.barcodeSearchableField.findUnique({ where: { companyId_key: { companyId, key: dto.key } } });
      if (existing && !existing.archivedAt) {
        throw new BadRequestException({ code: 'BARCODE_FIELD_EXISTS', message: 'A searchable field with this key already exists.' });
      }
      if (existing) {
        // Revive rather than hit the (companyId, key) unique constraint — no
        // hard deletes means the archived row is still there to reclaim.
        return tx.barcodeSearchableField.update({
          where: { id: existing.id },
          data: { label: dto.label.trim(), isCustom, order: dto.order ?? existing.order, archivedAt: null },
        });
      }
      return tx.barcodeSearchableField.create({
        data: { companyId, key: dto.key, label: dto.label.trim(), isCustom, order: dto.order ?? 0 },
      });
    });
  }

  async updateSearchableField(companyId: string, id: string, dto: UpdateSearchableFieldDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireSearchableField(tx, companyId, id);
      return tx.barcodeSearchableField.update({
        where: { id },
        data: { label: dto.label?.trim(), order: dto.order },
      });
    });
  }

  async archiveSearchableField(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const field = await this.requireSearchableField(tx, companyId, id);
      if (field.archivedAt) return field;
      return tx.barcodeSearchableField.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  private async requireSearchableField(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const field = await tx.barcodeSearchableField.findUnique({ where: { id } });
    if (!field || field.companyId !== companyId) {
      throw new NotFoundException({ code: 'BARCODE_FIELD_NOT_FOUND', message: 'Searchable field not found.' });
    }
    return field;
  }

  // ---- Field mappings ----

  async createFieldMapping(companyId: string, dto: CreateFieldMappingDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      this.assertMappingShape(dto.targetField, dto.customFieldKey);
      return tx.barcodeFieldMapping.create({
        data: {
          companyId,
          sourceField: dto.sourceField,
          targetField: dto.targetField,
          customFieldKey: dto.customFieldKey ?? null,
          isDatabaseLookup: dto.isDatabaseLookup ?? false,
          order: dto.order ?? 0,
        },
      });
    });
  }

  async updateFieldMapping(companyId: string, id: string, dto: UpdateFieldMappingDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const mapping = await this.requireFieldMapping(tx, companyId, id);
      const targetField = dto.targetField ?? mapping.targetField;
      const customFieldKey = dto.customFieldKey !== undefined ? dto.customFieldKey : (mapping.customFieldKey ?? undefined);
      this.assertMappingShape(targetField, customFieldKey);
      return tx.barcodeFieldMapping.update({
        where: { id },
        data: {
          sourceField: dto.sourceField,
          targetField: dto.targetField,
          customFieldKey: dto.customFieldKey,
          isDatabaseLookup: dto.isDatabaseLookup,
          order: dto.order,
        },
      });
    });
  }

  async archiveFieldMapping(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const mapping = await this.requireFieldMapping(tx, companyId, id);
      if (mapping.archivedAt) return mapping;
      return tx.barcodeFieldMapping.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  private assertMappingShape(targetField: BarcodeFieldTarget, customFieldKey?: string): void {
    if (targetField === 'CUSTOM_FIELD' && !customFieldKey) {
      throw new BadRequestException({ code: 'BARCODE_MAPPING_MISSING_CUSTOM_KEY', message: 'customFieldKey is required when targetField is CUSTOM_FIELD.' });
    }
  }

  private async requireFieldMapping(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const mapping = await tx.barcodeFieldMapping.findUnique({ where: { id } });
    if (!mapping || mapping.companyId !== companyId) {
      throw new NotFoundException({ code: 'BARCODE_MAPPING_NOT_FOUND', message: 'Field mapping not found.' });
    }
    return mapping;
  }

  // ---- Scan ----

  async scan(companyId: string, userId: string, dto: ScanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStop(tx, companyId, dto.jobId, dto.stopId);
      const config = await this.ensureConfig(tx, companyId);
      const searchableFields = await tx.barcodeSearchableField.findMany({ where: { companyId, archivedAt: null } });
      const mappings = await tx.barcodeFieldMapping.findMany({
        where: { companyId, archivedAt: null },
        orderBy: { order: 'asc' },
      });

      // MVP decode only — full GS1 Application-Identifier parsing is a
      // follow-up, not attempted here (see Barcode_Scanning.md decode step).
      const decoded =
        config.scanMode === 'DATABASE_LOOKUP' ? { scan: dto.scannedValue } : decodeScan(dto.scannedValue);

      const matchedParcel = await this.findMatch(tx, companyId, config.scanMode, decoded, dto.scannedValue, searchableFields);
      const populatedFields = this.buildPopulatedFields(mappings, decoded, matchedParcel);

      let outcome: BarcodeScanOutcome;
      let missingFields: string[] | undefined;

      if (matchedParcel) {
        const job = matchedParcel.stop.job;
        const blockedByStatus = job.status === 'CANCELLED' || job.status === 'COMPLETED';
        const blockedBySameStop = matchedParcel.stopId === dto.stopId && matchedParcel.stop.jobId === dto.jobId;
        outcome = blockedByStatus || blockedBySameStop ? 'DUPLICATE_BLOCKED' : 'MATCHED';
      } else if (config.scanMode !== 'DATABASE_LOOKUP' && config.blockOnMissingFields && config.requiredFields.length > 0) {
        const missing = config.requiredFields.filter((f) => !this.hasPopulatedValue(populatedFields, f));
        outcome = missing.length > 0 ? 'MISSING_FIELDS' : 'UNKNOWN';
        missingFields = missing.length > 0 ? missing : undefined;
      } else {
        // Never fail silently — an unrecognised/incomplete scan still comes
        // back as a normal (non-error) outcome so the operator can continue.
        outcome = 'UNKNOWN';
      }

      const event = await tx.barcodeScanEvent.create({
        data: {
          companyId,
          userId,
          scannedValue: dto.scannedValue,
          scanMode: config.scanMode,
          outcome,
          matchedParcelId: matchedParcel?.id ?? null,
        },
      });

      return {
        scanEventId: event.id,
        outcome,
        populatedFields,
        matchedParcel: matchedParcel
          ? {
              id: matchedParcel.id,
              reference: matchedParcel.reference,
              stopId: matchedParcel.stopId,
              jobId: matchedParcel.stop.jobId,
              jobTitle: matchedParcel.stop.job.title,
            }
          : undefined,
        missingFields,
      };
    });
  }

  async createFromScan(companyId: string, scanEventId: string, dto: CreateFromScanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStop(tx, companyId, dto.jobId, dto.stopId);
      // The scan event just anchors this creation to a prior /scan call for
      // audit purposes — a scan can also come back UNKNOWN and be created
      // from directly, so its existence is checked but not otherwise required
      // to shape the created parcel.
      const scanEvent = await tx.barcodeScanEvent.findFirst({ where: { id: scanEventId, companyId } });
      if (!scanEvent) {
        throw new NotFoundException({ code: 'BARCODE_SCAN_EVENT_NOT_FOUND', message: 'Scan event not found.' });
      }
      const f = dto.fields;
      try {
        return await tx.stopParcel.create({
          data: {
            companyId,
            stopId: dto.stopId,
            reference: f.reference,
            trackingNumber: f.trackingNumber ?? null,
            consignmentNumber: f.consignmentNumber ?? null,
            manifestNumber: f.manifestNumber ?? null,
            internalId: f.internalId ?? null,
            customerReference: f.customerReference ?? null,
            deliveryAddress: f.deliveryAddress ?? null,
            contactName: f.contactName ?? null,
            deliveryNotes: f.deliveryNotes ?? null,
            serviceType: f.serviceType ?? null,
            parcelCount: f.parcelCount ?? null,
            weightKg: f.weightKg ?? null,
            cubicM3: f.cubicM3 ?? null,
            dangerousGoods: f.dangerousGoods ?? false,
            customFields: (f.customFields as Prisma.InputJsonValue) ?? undefined,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException({ code: 'BARCODE_PARCEL_EXISTS', message: 'A parcel with this reference already exists on this stop.' });
        }
        throw err;
      }
    });
  }

  async scanHistory(companyId: string, userId: string, limit: number) {
    const take = Math.min(limit, MAX_PAGE_SIZE);
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.barcodeScanEvent.findMany({
        where: { companyId, userId },
        orderBy: { createdAt: 'desc' },
        take,
      });
      return { items };
    });
  }

  private async requireStop(tx: Prisma.TransactionClient, companyId: string, jobId: string, stopId: string) {
    const stop = await tx.jobStop.findFirst({ where: { id: stopId, jobId, job: { companyId } }, select: { id: true } });
    if (!stop) {
      throw new NotFoundException({ code: 'STOP_NOT_FOUND', message: 'Delivery stop not found.' });
    }
    return stop;
  }

  /**
   * DATABASE_LOOKUP always searches the raw scanned text against every active
   * searchable column. ENCODED_BARCODE searches only the fields the decode
   * step actually produced, matched to their own decoded value (a barcode
   * that encodes its own trackingNumber shouldn't be matched by accidentally
   * equalling some OTHER column). HYBRID tries the targeted decode-based
   * search first and falls back to the raw whole-value search if that finds
   * nothing — "a HYBRID fallback for anything the decode step didn't
   * produce."
   */
  private async findMatch(
    tx: Prisma.TransactionClient,
    companyId: string,
    scanMode: BarcodeScanMode,
    decoded: Record<string, string>,
    rawValue: string,
    searchableFields: { key: string; isCustom: boolean }[],
  ): Promise<MatchedParcel | null> {
    if (searchableFields.length === 0) return null;

    const { targetedOr, rawOr } = buildMatchConditions(searchableFields, decoded, rawValue);

    const include = { stop: { include: { job: true, customer: true } } } as const;

    if (scanMode === 'DATABASE_LOOKUP') {
      if (rawOr.length === 0) return null;
      return tx.stopParcel.findFirst({ where: { companyId, OR: rawOr }, include, orderBy: { createdAt: 'desc' } });
    }
    if (scanMode === 'ENCODED_BARCODE') {
      if (targetedOr.length === 0) return null;
      return tx.stopParcel.findFirst({ where: { companyId, OR: targetedOr }, include, orderBy: { createdAt: 'desc' } });
    }
    // HYBRID
    if (targetedOr.length > 0) {
      const match = await tx.stopParcel.findFirst({ where: { companyId, OR: targetedOr }, include, orderBy: { createdAt: 'desc' } });
      if (match) return match;
    }
    if (rawOr.length === 0) return null;
    return tx.stopParcel.findFirst({ where: { companyId, OR: rawOr }, include, orderBy: { createdAt: 'desc' } });
  }

  private buildPopulatedFields(
    mappings: { sourceField: string; targetField: BarcodeFieldTarget; customFieldKey: string | null; isDatabaseLookup: boolean; order: number }[],
    decoded: Record<string, string>,
    matchedParcel: MatchedParcel | null,
  ): PopulatedFields {
    const populated: PopulatedFields = {};
    for (const mapping of mappings) {
      let value: unknown;
      if (mapping.isDatabaseLookup) {
        if (!matchedParcel) continue;
        value = this.resolveLookupValue(mapping.targetField, mapping.customFieldKey, matchedParcel);
      } else {
        value = decoded[mapping.sourceField];
      }
      if (value === undefined || value === null || value === '') continue;
      this.setPopulatedField(populated, mapping.targetField, mapping.customFieldKey, value);
    }
    return populated;
  }

  private resolveLookupValue(
    targetField: BarcodeFieldTarget,
    customFieldKey: string | null,
    matchedParcel: MatchedParcel,
  ): unknown {
    if (targetField === 'CUSTOMER') {
      const customer = matchedParcel.stop.customer;
      return customer ? { id: customer.id, name: customer.name } : undefined;
    }
    if (targetField === 'CUSTOM_FIELD') {
      if (!customFieldKey) return undefined;
      const customFields = matchedParcel.customFields as Record<string, unknown> | null;
      return customFields?.[customFieldKey];
    }
    const column = TARGET_TO_STOPPARCEL_COLUMN[targetField];
    if (!column) return undefined;
    return (matchedParcel as unknown as Record<string, unknown>)[column];
  }

  private setPopulatedField(populated: PopulatedFields, targetField: BarcodeFieldTarget, customFieldKey: string | null, value: unknown): void {
    if (targetField === 'CUSTOM_FIELD') {
      if (!customFieldKey) return;
      populated.customFields = { ...(populated.customFields ?? {}), [customFieldKey]: value };
      return;
    }
    if (targetField === 'CUSTOMER') {
      populated.customer = typeof value === 'object' ? (value as { id?: string; name: string }) : { name: String(value) };
      return;
    }
    if (targetField === 'PARCEL_COUNT') {
      populated.parcelCount = Number(value);
      return;
    }
    if (targetField === 'WEIGHT') {
      populated.weightKg = Number(value);
      return;
    }
    if (targetField === 'CUBIC') {
      populated.cubicM3 = Number(value);
      return;
    }
    if (targetField === 'DANGEROUS_GOODS') {
      populated.dangerousGoods = typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
      return;
    }
    const key = TARGET_TO_RESPONSE_KEY[targetField];
    if (key) populated[key] = value;
  }

  private hasPopulatedValue(populated: PopulatedFields, targetField: string): boolean {
    if (targetField === 'CUSTOMER') return populated.customer !== undefined;
    if (targetField === 'CUSTOM_FIELD') return false; // not a meaningful required-field on its own (no key to check)
    const key = TARGET_TO_RESPONSE_KEY[targetField as BarcodeFieldTarget];
    if (!key) return false;
    const value = populated[key];
    return value !== undefined && value !== null && value !== '';
  }
}
