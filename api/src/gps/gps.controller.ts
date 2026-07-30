import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { REGISTRATION_THROTTLE } from '../common/throttles';
import { GpsService } from './gps.service';
import { IngestGpsDto, RegisterGpsDeviceDto, UpdateGpsDeviceDto } from './dto/gps.dto';

@Controller({ path: 'gps', version: '1' })
export class GpsController {
  constructor(private readonly service: GpsService) {}

  /**
   * Universal ingest. Public (no user login) — a hardware tracker or telematics
   * webhook authenticates with its device key in the body. This is the single
   * endpoint any GPS source POSTs to.
   */
  @Public()
  @Post('ingest')
  ingest(@Body() dto: IngestGpsDto) {
    return this.service.ingest(dto);
  }

  @Get('devices')
  @RequirePermission(PERMISSIONS.GPS_DEVICE_MANAGE)
  listDevices(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.listDevices(user.companyId);
  }

  // Registration mints a device key (a long-lived credential) — rate-limit it
  // so the credential-minting surface can't be hammered.
  @Post('devices')
  @Throttle(REGISTRATION_THROTTLE)
  @RequirePermission(PERMISSIONS.GPS_DEVICE_MANAGE)
  register(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: RegisterGpsDeviceDto) {
    return this.service.register(user.companyId, dto);
  }

  @Patch('devices/:id')
  @RequirePermission(PERMISSIONS.GPS_DEVICE_MANAGE)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGpsDeviceDto) {
    return this.service.update(user.companyId, id, dto);
  }

  @Post('devices/:id/rotate-key')
  @RequirePermission(PERMISSIONS.GPS_DEVICE_MANAGE)
  rotateKey(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.rotateKey(user.companyId, user.userId, id);
  }

  @Post('devices/:id/archive')
  @RequirePermission(PERMISSIONS.GPS_DEVICE_MANAGE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(user.companyId, id);
  }

  /** Asset positions reported by GPS hardware — for the live map. */
  @Get('positions')
  @RequirePermission(PERMISSIONS.LOCATION_VIEW)
  positions(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.positions(user.companyId);
  }
}
