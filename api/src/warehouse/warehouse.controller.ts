import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { WarehouseService } from './warehouse.service';
import {
  AdjustStockDto,
  CreateStockItemDto,
  ImportStockRowsDto,
  ListStockDto,
  UpdateStockItemDto,
} from './dto/stock.dto';
import {
  CreateMachineDto,
  CreateMachineLogDto,
  ListMachinesDto,
  UpdateMachineDto,
} from './dto/machine.dto';
import { CopyMachineScheduleDto, CreateMachinePlanDto, UpdateMachinePlanDto } from './dto/machine-plan.dto';

/**
 * Warehouse add-on API. Two independent gates apply to every route:
 *  - **Permission** — `warehouse:manage` to mutate, `warehouse:view` to read
 *    ("is this user allowed to do this inside their company").
 *  - **Entitlement** — the `warehouse` plan feature, enforced server-side by
 *    FeatureGuard via the controller-level `@RequireFeature` below ("has this
 *    company paid for the add-on at all"). Without it the request is rejected
 *    with 402 `FEATURE_NOT_IN_PLAN`, so hiding the module in the client is no
 *    longer the only thing standing between a Free plan and the add-on.
 *
 * The paywall is inert until `BILLING_ENFORCED=true` — see FeatureGuard.
 * Existing warehouse data is never deleted when a plan lapses; it simply
 * becomes unreachable until the company upgrades again.
 */
@Controller({ path: 'warehouse', version: '1' })
@RequireFeature('warehouse')
export class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  // Stock
  @Post('stock')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  createStock(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateStockItemDto) {
    return this.warehouse.createStock(user.companyId, dto);
  }

  @Get('stock')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listStock(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListStockDto) {
    return this.warehouse.listStock(user.companyId, query);
  }

  @Post('stock/import')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  importStock(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportStockRowsDto) {
    return this.warehouse.importStock(user.companyId, dto);
  }

  @Patch('stock/:id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  updateStock(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockItemDto,
  ) {
    return this.warehouse.updateStock(user.companyId, id, dto);
  }

  @Post('stock/:id/adjust')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  adjustStock(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStockDto,
  ) {
    return this.warehouse.adjustStock(user.companyId, user.userId, id, dto);
  }

  @Get('stock/:id/adjustments')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listStockAdjustments(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.listStockAdjustments(user.companyId, id);
  }

  @Post('stock/:id/archive')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  archiveStock(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.archiveStock(user.companyId, id);
  }

  // Machines
  @Post('machines')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  createMachine(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateMachineDto) {
    return this.warehouse.createMachine(user.companyId, dto);
  }

  @Get('machines')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listMachines(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListMachinesDto) {
    return this.warehouse.listMachines(user.companyId, query);
  }

  @Patch('machines/:id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  updateMachine(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMachineDto,
  ) {
    return this.warehouse.updateMachine(user.companyId, id, dto);
  }

  @Post('machines/:id/archive')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  archiveMachine(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.archiveMachine(user.companyId, id);
  }

  @Post('machines/:id/logs')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  addMachineLog(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMachineLogDto,
  ) {
    return this.warehouse.addMachineLog(user.companyId, user.userId, id, dto);
  }

  @Get('machines/:id/logs')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listMachineLogs(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.listMachineLogs(user.companyId, id);
  }

  // Machine maintenance schedules (savable/deployable plans)
  @Get('machine-plan-presets')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  machinePlanPresets() {
    return { items: this.warehouse.machinePlanPresets() };
  }

  @Get('machine-plans')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listAllMachinePlans(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.warehouse.listAllMachinePlans(user.companyId);
  }

  @Get('machines/:id/plans')
  @RequirePermission(PERMISSIONS.WAREHOUSE_VIEW)
  listMachinePlans(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.listMachinePlansForMachine(user.companyId, id);
  }

  @Post('machines/:id/plans')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  createMachinePlan(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMachinePlanDto,
  ) {
    return this.warehouse.createMachinePlan(user.companyId, id, dto);
  }

  @Post('machines/:id/plans/copy-to')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  copyMachineSchedule(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CopyMachineScheduleDto,
  ) {
    return this.warehouse.copyMachineSchedule(user.companyId, id, dto.targetMachineIds);
  }

  @Patch('machine-plans/:id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  updateMachinePlan(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMachinePlanDto,
  ) {
    return this.warehouse.updateMachinePlan(user.companyId, id, dto);
  }

  @Post('machine-plans/:id/service')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  serviceMachinePlan(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.serviceMachinePlan(user.companyId, user.userId, id);
  }

  @Post('machine-plans/:id/archive')
  @RequirePermission(PERMISSIONS.WAREHOUSE_MANAGE)
  archiveMachinePlan(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouse.archiveMachinePlan(user.companyId, id);
  }
}
