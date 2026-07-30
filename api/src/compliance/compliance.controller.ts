import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ComplianceService } from './compliance.service';
import { CreateComplianceDocumentDto } from './dto/create-compliance-document.dto';
import { UpdateComplianceDocumentDto } from './dto/update-compliance-document.dto';
import { ListComplianceDocumentsDto } from './dto/list-compliance-documents.dto';

@Controller({ path: 'compliance-documents', version: '1' })
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Post()
  @RequirePermission(PERMISSIONS.COMPLIANCE_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateComplianceDocumentDto) {
    return this.complianceService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListComplianceDocumentsDto) {
    return this.complianceService.findAll(user.companyId, query);
  }

  // Declared before `:id` so "summary"/"position" aren't captured as a document id.
  @Get('summary')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  summary(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.complianceService.summary(user.companyId);
  }

  /** Dashboard "Compliance position" — six live currency rates. */
  @Get('position')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  position(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.complianceService.position(user.companyId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.complianceService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.COMPLIANCE_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComplianceDocumentDto,
  ) {
    return this.complianceService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.COMPLIANCE_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.complianceService.archive(user.companyId, user.userId, id);
  }
}
