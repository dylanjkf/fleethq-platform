/**
 * The FleetHQ entities an IntegrationConnection can import into. Deliberately
 * the exact same entity keys the bulk `imports` module already supports (see
 * imports.service.ts's importAssets/importOperators/importDepots/
 * importCustomers/importAttachedUnits/importComplianceDocuments) — the
 * Integration Hub reuses those create paths rather than inventing its own
 * per-entity validation, so the set of syncable entities is defined once,
 * here, and can't drift from what `imports` actually supports.
 */
export const ALLOWED_TARGET_ENTITIES = [
  'assets',
  'operators',
  'depots',
  'customers',
  'attached_units',
  'compliance_documents',
] as const;

export type TargetEntity = (typeof ALLOWED_TARGET_ENTITIES)[number];
