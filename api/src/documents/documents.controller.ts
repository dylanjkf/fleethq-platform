import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { BulkUploadDocumentsDto } from './dto/bulk-upload-documents.dto';

@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.DOCUMENTS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateDocumentDto) {
    return this.documents.create(user.companyId, user.userId, dto);
  }

  /**
   * Upload a batch of files at once. Always 201 with a per-file result — a
   * partially successful batch is a normal outcome, not an error, so the caller
   * gets told exactly which files landed rather than a single pass/fail.
   */
  @Post('bulk')
  @RequirePermission(PERMISSIONS.DOCUMENTS_CREATE)
  bulkUpload(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: BulkUploadDocumentsDto) {
    return this.documents.bulkUpload(user.companyId, user.userId, user.membershipId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.DOCUMENTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListDocumentsDto) {
    return this.documents.findAll(user.companyId, query);
  }

  @Get(':id/download')
  @RequirePermission(PERMISSIONS.DOCUMENTS_VIEW)
  async download(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.documents.download(user.companyId, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DOCUMENTS_CREATE)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documents.update(user.companyId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.DOCUMENTS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.archive(user.companyId, id);
  }
}
