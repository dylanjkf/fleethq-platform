import { Injectable } from '@nestjs/common';
import { IntegrationTransform } from '@prisma/client';
import { IntegrationTransformService } from './integration-transform.service';

/** The subset of an IntegrationFieldMapping row the engine actually needs. */
export interface FieldMappingLike {
  externalField: string;
  fleetField: string;
  transform: IntegrationTransform;
  transformConfig: unknown;
  isRequired: boolean;
  order: number;
}

export interface MappingResult {
  mapped: Record<string, unknown>;
  missingRequiredFields: string[];
}

/**
 * The Universal Data Mapping Engine: walks a connection's active field
 * mappings in order, reads each external field off the raw row, applies its
 * transform, and builds the FleetHQ-shaped row the reused entity `create`
 * path expects. Collects which required mappings had no resolvable value so
 * the caller can report/dead-letter the row without throwing.
 */
@Injectable()
export class IntegrationMappingEngine {
  constructor(private readonly transforms: IntegrationTransformService) {}

  map(mappings: FieldMappingLike[], row: Record<string, unknown>): MappingResult {
    const ordered = [...mappings].sort((a, b) => a.order - b.order);
    const mapped: Record<string, unknown> = {};
    const missingRequiredFields: string[] = [];

    for (const mapping of ordered) {
      const raw = row[mapping.externalField];
      const value = this.transforms.apply(mapping.transform, raw, mapping.transformConfig as Record<string, unknown> | null | undefined);
      const isEmpty = value === null || value === undefined || value === '';
      if (mapping.isRequired && isEmpty) {
        missingRequiredFields.push(mapping.fleetField);
        continue;
      }
      if (!isEmpty) mapped[mapping.fleetField] = value;
    }

    return { mapped, missingRequiredFields };
  }
}
