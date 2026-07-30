import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { UPLOAD_THROTTLE } from '../common/throttles';
import { AttachmentsService } from './attachments.service';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';

@Controller({ path: 'attachments', version: '1' })
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // Each upload can carry several megabytes of decoded binary; cap the rate so
  // one account can't flood storage/CPU (magic-byte sniffing runs on each).
  @Post()
  @Throttle(UPLOAD_THROTTLE)
  @RequirePermission(PERMISSIONS.ATTACHMENTS_UPLOAD)
  upload(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UploadAttachmentDto) {
    return this.attachments.upload(user.companyId, user.userId, dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ATTACHMENTS_VIEW)
  async download(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.attachments.getForDownload(user.companyId, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }
}
