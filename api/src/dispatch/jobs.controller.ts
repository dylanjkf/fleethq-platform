import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BULK_THROTTLE } from '../common/throttles';
import { JobsService } from './jobs.service';
import { JobStopsService } from './job-stops.service';
import { PodReceiptService } from './pod-receipt.service';
import { ParcelsService } from './parcels.service';
import { LoadVerificationService } from './load-verification.service';
import { AddParcelsDto, ScanParcelDto } from './dto/parcels.dto';
import { LoadVerificationDto } from './dto/load-verification.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { AssignJobDto } from './dto/assign-job.dto';
import { ListJobsDto } from './dto/list-jobs.dto';
import { AddStopsDto } from './dto/add-stops.dto';
import { CompleteStopDto } from './dto/complete-stop.dto';
import { DuplicateJobDto } from './dto/duplicate-job.dto';
import { ReorderStopsDto } from './dto/reorder-stops.dto';
import { ReattemptStopDto } from './dto/reattempt-stop.dto';
import { ImportRowsDto } from '../imports/dto/import-rows.dto';

@Controller({ path: 'jobs', version: '1' })
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly jobStops: JobStopsService,
    private readonly podReceipt: PodReceiptService,
    private readonly parcels: ParcelsService,
    private readonly loadVerification: LoadVerificationService,
  ) {}

  /** Aggregated expected load for a run + its discrepancies (DriverOS "Confirm load"). */
  @Get(':id/load-status')
  @RequirePermission(PERMISSIONS.DISPATCH_VIEW)
  loadStatus(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.loadVerification.getLoadStatus(user.companyId, id);
  }

  /** Driver verifies the vehicle's load before starting a run — rejects a partial load unless overridden. */
  @Post(':id/load-verification')
  @RequirePermission(PERMISSIONS.DISPATCH_DELIVER)
  verifyLoad(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LoadVerificationDto,
  ) {
    return this.loadVerification.verifyLoad(user.companyId, user.userId, id, dto);
  }

  /** A stop's parcels + scanned/total (DriverOS parcel screen). */
  @Get(':id/stops/:stopId/parcels')
  @RequirePermission(PERMISSIONS.DISPATCH_DELIVER)
  getParcels(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
  ) {
    return this.parcels.getParcels(user.companyId, id, stopId);
  }

  /** Office pre-lists a stop's parcels (from a manifest). */
  @Post(':id/stops/:stopId/parcels')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  addParcels(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: AddParcelsDto,
  ) {
    return this.parcels.addParcels(user.companyId, id, stopId, dto);
  }

  /** Driver scans a parcel at the stop (DriverOS) — adds it if it wasn't listed. */
  @Post(':id/stops/:stopId/parcels/scan')
  @RequirePermission(PERMISSIONS.DISPATCH_DELIVER)
  scanParcel(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ScanParcelDto,
  ) {
    return this.parcels.scanParcel(user.companyId, id, stopId, dto);
  }

  /** Downloadable Proof-of-Delivery receipt (PDF) for a completed stop. */
  @Get(':id/stops/:stopId/receipt')
  @RequirePermission(PERMISSIONS.DISPATCH_VIEW)
  async stopReceipt(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Res() res: Response,
  ) {
    const file = await this.podReceipt.buildStopReceipt(user.companyId, id, stopId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(file.data);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DISPATCH_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateJobDto) {
    return this.jobsService.create(user.companyId, user.userId, dto);
  }

  /** Create many runs in one action, per-row independent. Same dispatch:create gate. */
  @Post('bulk')
  @Throttle(BULK_THROTTLE)
  @RequirePermission(PERMISSIONS.DISPATCH_CREATE)
  bulkCreate(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportRowsDto) {
    return this.jobsService.bulkCreate(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.DISPATCH_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListJobsDto) {
    return this.jobsService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DISPATCH_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobsService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
  ) {
    return this.jobsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/assign')
  @RequirePermission(PERMISSIONS.DISPATCH_ASSIGN)
  assign(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignJobDto,
  ) {
    return this.jobsService.assign(user.companyId, user.userId, id, dto);
  }

  @Post(':id/complete')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  complete(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobsService.complete(user.companyId, user.userId, id);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.DISPATCH_CANCEL)
  cancel(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobsService.cancel(user.companyId, user.userId, id);
  }

  @Post(':id/duplicate')
  @RequirePermission(PERMISSIONS.DISPATCH_CREATE)
  duplicate(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateJobDto,
  ) {
    return this.jobsService.duplicate(user.companyId, user.userId, id, dto);
  }

  @Post(':id/stops')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  addStops(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddStopsDto,
  ) {
    return this.jobStops.addStops(user.companyId, user.userId, id, dto);
  }

  @Post(':id/stops/import')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  importStops(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImportRowsDto,
  ) {
    return this.jobStops.importStops(user.companyId, user.userId, id, dto);
  }

  @Post(':id/stops/:stopId/reattempt')
  @RequirePermission(PERMISSIONS.DISPATCH_CREATE)
  reattemptStop(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ReattemptStopDto,
  ) {
    return this.jobStops.reattemptStop(user.companyId, user.userId, id, stopId, dto);
  }

  @Post(':id/stops/reorder')
  @RequirePermission(PERMISSIONS.DISPATCH_EDIT)
  reorderStops(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderStopsDto,
  ) {
    return this.jobStops.reorderStops(user.companyId, user.userId, id, dto);
  }

  @Post(':id/stops/:stopId/complete')
  @RequirePermission(PERMISSIONS.DISPATCH_DELIVER)
  completeStop(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: CompleteStopDto,
  ) {
    return this.jobStops.completeStop(user.companyId, user.userId, id, stopId, dto);
  }
}
