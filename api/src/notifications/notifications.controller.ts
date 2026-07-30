import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { NotificationsService } from './notifications.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NOTIFICATION_TYPES } from './notification-types';

/**
 * Personal notifications — every authenticated user sees only their own, so
 * these routes carry no @RequirePermission (the JwtAuthGuard still applies).
 * Adding a permission every role would need only invites seed drift for no gain.
 * The digest routes are the exception: they act on every user's pending
 * notifications company-wide, so those ARE gated.
 */
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @AuthenticatedOnly()
  list(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.notifications.listForUser(user.companyId, user.userId);
  }

  @Post(':id/read')
  @AuthenticatedOnly()
  markRead(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.companyId, user.userId, id);
  }

  @Post('read-all')
  @AuthenticatedOnly()
  markAllRead(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.notifications.markAllRead(user.companyId, user.userId);
  }

  @Get('types')
  @AuthenticatedOnly()
  listTypes() {
    return NOTIFICATION_TYPES;
  }

  @Get('preferences')
  @AuthenticatedOnly()
  getPreferences(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.notifications.getPreferences(user.companyId, user.userId);
  }

  @Patch('preferences')
  @AuthenticatedOnly()
  updatePreferences(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UpdateNotificationPreferencesDto) {
    return this.notifications.updatePreferences(user.companyId, user.userId, dto);
  }

  @Get('digest/preview')
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_DIGEST_SEND)
  previewDigest(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.notifications.previewDigest(user.companyId);
  }

  @Post('digest/send')
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_DIGEST_SEND)
  sendDigest(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.notifications.sendDigest(user.companyId);
  }
}
