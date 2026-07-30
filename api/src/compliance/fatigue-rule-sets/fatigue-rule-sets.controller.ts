import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { FatigueRuleSetsService } from './fatigue-rule-sets.service';
import { CreateFatigueRuleSetDto, DeployFatigueRuleSetDto, UpdateFatigueRuleSetDto } from './dto/fatigue-rule-set.dto';

@Controller({ path: 'fatigue-rule-sets', version: '1' })
export class FatigueRuleSetsController {
  constructor(private readonly service: FatigueRuleSetsService) {}

  /** The built-in default numbers, to seed a new rule set from. */
  @Get('preset')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  preset() {
    return this.service.preset();
  }

  @Get()
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.FATIGUE_MANAGE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateFatigueRuleSetDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.FATIGUE_MANAGE)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFatigueRuleSetDto) {
    return this.service.update(user.companyId, id, dto);
  }

  @Post(':id/deploy')
  @RequirePermission(PERMISSIONS.FATIGUE_MANAGE)
  deploy(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeployFatigueRuleSetDto) {
    return this.service.deploy(user.companyId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.FATIGUE_MANAGE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(user.companyId, id);
  }
}
