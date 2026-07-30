import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BULK_THROTTLE } from '../common/throttles';
import { ImportsService } from './imports.service';
import { ImportRowsDto } from './dto/import-rows.dto';

/**
 * Bulk-input endpoints for Assets/Operators/Depots/Customers/AttachedUnits/
 * ComplianceDocuments — gated on the same *:create permissions manual
 * creation already uses, per 01-Product/Onboarding_Import.md's "import is a
 * bulk input method, not a distinct capability" requirement. No new
 * permission category. (A compliance document row can't carry a file scan —
 * CSV has no binary column — so an imported row is always photo-less; add
 * one later via the normal edit flow.)
 */
// Bulk endpoints ingest whole spreadsheets — a handful a minute is more than
// any real onboarding needs, and it caps how fast one account can push work.
@Throttle(BULK_THROTTLE)
@Controller({ path: 'imports', version: '1' })
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('assets')
  @RequirePermission(PERMISSIONS.ASSETS_CREATE)
  importAssets(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importAssets(user.companyId, user.userId, dto);
  }

  @Post('operators')
  @RequirePermission(PERMISSIONS.OPERATORS_CREATE)
  importOperators(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importOperators(user.companyId, user.userId, dto);
  }

  @Post('depots')
  @RequirePermission(PERMISSIONS.DEPOTS_CREATE)
  importDepots(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importDepots(user.companyId, user.userId, dto);
  }

  @Post('customers')
  @RequirePermission(PERMISSIONS.CUSTOMERS_CREATE)
  importCustomers(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importCustomers(user.companyId, user.userId, dto);
  }

  @Post('attached-units')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_CREATE)
  importAttachedUnits(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importAttachedUnits(user.companyId, user.userId, dto);
  }

  @Post('compliance-documents')
  @RequirePermission(PERMISSIONS.COMPLIANCE_CREATE)
  importComplianceDocuments(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.importsService.importComplianceDocuments(user.companyId, user.userId, dto);
  }
}
