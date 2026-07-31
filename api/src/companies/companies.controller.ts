import { Body, Controller, Get, Ip, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { CompaniesService } from './companies.service';
import { SignupCompanyDto } from './dto/signup-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  /**
   * Creates a Company, its Administrator/Read Only role templates, and the
   * first admin User atomically, then logs that user straight in — no
   * separate POST /v1/auth/login round-trip needed. No trial is granted
   * (FleetHQ has no self-service signup/free-trial product path — a
   * prospective customer's only route in is the public contact form, see
   * src/contact/). This endpoint remains for direct/internal provisioning.
   */
  @Public()
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 10, ttl: 60_000 } })
  @Post()
  signup(@Body() dto: SignupCompanyDto, @Ip() ip: string, @Req() req: Request) {
    return this.companiesService.signup(dto, { ip, userAgent: req.get('user-agent') ?? null });
  }

  @Get('me')
  @RequirePermission(PERMISSIONS.COMPANIES_VIEW)
  getMe(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.companiesService.getMe(user.companyId);
  }

  /**
   * 01-Product/Support_Help_Pathway.md: no @RequirePermission — every
   * authenticated user (including a Driver role with no companies:view)
   * can read the company's support contact, the same "every user manages/
   * reads their own context" precedent as notification preferences.
   */
  @Get('me/support')
  @AuthenticatedOnly()
  getSupportInfo(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.companiesService.getSupportInfo(user.companyId);
  }

  @Patch('me')
  @RequirePermission(PERMISSIONS.COMPANIES_EDIT)
  updateMe(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UpdateCompanyDto) {
    return this.companiesService.updateMe(user.companyId, user.userId, dto);
  }
}
