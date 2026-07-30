import { Injectable, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssetsService } from '../assets/assets.service';
import { OperatorsService } from '../operators/operators.service';
import { DepotsService } from '../depots/depots.service';
import { CustomersService } from '../customers/customers.service';
import { AttachedUnitsService } from '../attached-units/attached-units.service';
import { ComplianceService } from '../compliance/compliance.service';
import { CreateAssetDto } from '../assets/dto/create-asset.dto';
import { CreateOperatorDto } from '../operators/dto/create-operator.dto';
import { CreateDepotDto } from '../depots/dto/create-depot.dto';
import { CreateCustomerDto } from '../customers/dto/create-customer.dto';
import { CreateAttachedUnitDto } from '../attached-units/dto/create-attached-unit.dto';
import { CreateComplianceDocumentDto } from '../compliance/dto/create-compliance-document.dto';
import {
  describeImportRowError,
  flattenValidationErrors,
  summarizeImportRows,
  type ImportResult,
  type ImportRowResult,
} from '../common/imports/import-helpers';
import { ImportRowsDto } from './dto/import-rows.dto';

export type { ImportResult, ImportRowResult };

/**
 * Bulk-input path for Asset/Operator/Depot/Customer creation
 * (01-Product/Onboarding_Import.md). Reuses each resource's own service
 * `create()` directly per row rather than duplicating validation or write
 * logic — an imported record is created exactly the way a manually-entered
 * one is, including its Timeline event. `dryRun` validates every row and
 * writes nothing; committing re-validates and creates only the valid rows,
 * independently, so one bad row never blocks the rows around it.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly operatorsService: OperatorsService,
    private readonly depotsService: DepotsService,
    private readonly customersService: CustomersService,
    private readonly attachedUnitsService: AttachedUnitsService,
    private readonly complianceService: ComplianceService,
  ) {}

  importAssets(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateAssetDto, (companyId, actorUserId, row) =>
      this.assetsService.create(companyId, actorUserId, row),
    );
  }

  importOperators(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateOperatorDto, (companyId, actorUserId, row) =>
      this.operatorsService.create(companyId, actorUserId, row),
    );
  }

  importDepots(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateDepotDto, (companyId, actorUserId, row) =>
      this.depotsService.create(companyId, actorUserId, row),
    );
  }

  importCustomers(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateCustomerDto, (companyId, actorUserId, row) =>
      this.customersService.create(companyId, actorUserId, row),
    );
  }

  importAttachedUnits(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateAttachedUnitDto, (companyId, actorUserId, row) =>
      this.attachedUnitsService.create(companyId, actorUserId, row),
    );
  }

  importComplianceDocuments(companyId: string, actorUserId: string | undefined, dto: ImportRowsDto): Promise<ImportResult> {
    return this.importRows(companyId, actorUserId, dto, CreateComplianceDocumentDto, (companyId, actorUserId, row) =>
      this.complianceService.create(companyId, actorUserId, row),
    );
  }

  private async importRows<T extends object>(
    companyId: string,
    actorUserId: string | undefined,
    dto: ImportRowsDto,
    dtoClass: Type<T>,
    create: (companyId: string, actorUserId: string | undefined, row: T) => Promise<{ id: string }>,
  ): Promise<ImportResult> {
    const dryRun = dto.dryRun ?? false;
    const rows: ImportRowResult[] = [];

    for (let index = 0; index < dto.rows.length; index++) {
      const instance = plainToInstance(dtoClass, dto.rows[index]);
      const errors = await validate(instance as object);
      if (errors.length > 0) {
        rows.push({ index, valid: false, created: false, errors: flattenValidationErrors(errors) });
        continue;
      }
      if (dryRun) {
        rows.push({ index, valid: true, created: false, errors: [] });
        continue;
      }
      try {
        const created = await create(companyId, actorUserId, instance);
        rows.push({ index, valid: true, created: true, errors: [], id: created.id });
      } catch (err) {
        rows.push({ index, valid: false, created: false, errors: [describeImportRowError(err)] });
      }
    }

    return summarizeImportRows(dto.rows.length, dryRun, rows);
  }
}
