import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BarcodeService } from './barcode.service';
import { UpdateBarcodeScanConfigDto, ScanHistoryQueryDto } from './dto/barcode-config.dto';
import { CreateSearchableFieldDto, UpdateSearchableFieldDto } from './dto/searchable-field.dto';
import { CreateFieldMappingDto, UpdateFieldMappingDto } from './dto/field-mapping.dto';
import { CreateFromScanDto, ScanDto } from './dto/scan.dto';

/**
 * Configurable barcode scanning (01-Product/Barcode_Scanning.md). Admin-config
 * routes (searchable fields, field mappings, scan mode) are gated on
 * `barcode_config:manage`, matching how GPS_DEVICE_MANAGE/ASSET_CLASS_MANAGE
 * collapse view+manage into one permission elsewhere in this catalog. The
 * actual scan/attach endpoint is gated on `dispatch:edit` instead — it's a
 * dispatch action (building a run), not a config change.
 */
@Controller({ path: 'barcode', version: '1' })
export class BarcodeController {
  constructor(private readonly barcode: BarcodeService) {}

  @Get('config')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  getConfig(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.barcode.getConfig(user.companyId);
  }

  @Patch('config')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  updateConfig(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UpdateBarcodeScanConfigDto) {
    return this.barcode.updateConfig(user.companyId, dto);
  }

  @Post('searchable-fields')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  createSearchableField(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateSearchableFieldDto) {
    return this.barcode.createSearchableField(user.companyId, dto);
  }

  @Patch('searchable-fields/:id')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  updateSearchableField(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSearchableFieldDto,
  ) {
    return this.barcode.updateSearchableField(user.companyId, id, dto);
  }

  @Post('searchable-fields/:id/archive')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  archiveSearchableField(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.barcode.archiveSearchableField(user.companyId, id);
  }

  @Post('field-mappings')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  createFieldMapping(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateFieldMappingDto) {
    return this.barcode.createFieldMapping(user.companyId, dto);
  }

  @Patch('field-mappings/:id')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  updateFieldMapping(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFieldMappingDto,
  ) {
    return this.barcode.updateFieldMapping(user.companyId, id, dto);
  }

  @Post('field-mappings/:id/archive')
  @RequirePermission(PERMISSIONS.BARCODE_CONFIG_MANAGE)
  archiveFieldMapping(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.barcode.archiveFieldMapping(user.companyId, id);
  }

  /** The core scan: decode/lookup against the caller's company config, log a
   *  BarcodeScanEvent, and return an outcome + whatever fields were resolved. */
  @Post('scan')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  scan(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ScanDto) {
    return this.barcode.scan(user.companyId, user.userId, dto);
  }

  /** Create the StopParcel a scan resolved (UNKNOWN) or that the operator chose to create anyway. */
  @Post('scan/:scanEventId/create')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  createFromScan(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('scanEventId', ParseUUIDPipe) scanEventId: string,
    @Body() dto: CreateFromScanDto,
  ) {
    return this.barcode.createFromScan(user.companyId, scanEventId, dto);
  }

  @Get('scan-history')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  scanHistory(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ScanHistoryQueryDto) {
    return this.barcode.scanHistory(user.companyId, user.userId, query.limit ?? 50);
  }
}
