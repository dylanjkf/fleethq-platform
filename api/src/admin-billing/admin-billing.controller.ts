import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminBillingService } from './admin-billing.service';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { AuditTrailQueryDto } from './dto/audit-trail-query.dto';
import { RefundDto } from './dto/refund.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { ManualInvoiceDto } from './dto/manual-invoice.dto';
import { CreditNoteDto } from './dto/credit-note.dto';
import { RetryPaymentDto } from './dto/retry-payment.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { ReleaseContractDto } from './dto/release-contract.dto';
import { Throttle } from '@nestjs/throttler';
import { ADMIN_SENSITIVE_ACTION_THROTTLE } from '../common/throttles';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/organisations/:companyId/billing', version: '1' })
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_VIEW)
  @Get()
  getStatus(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.billing.getStatus(companyId);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_VIEW)
  @Get('invoices')
  listInvoices(@Param('companyId', ParseUUIDPipe) companyId: string, @Query() query: ListInvoicesQueryDto) {
    return this.billing.listInvoices(companyId, query);
  }

  /** The per-company billing audit trail (cap blocks, quantity changes, signup lifecycle, dunning). */
  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_VIEW)
  @Get('audit')
  getAuditTrail(@Param('companyId', ParseUUIDPipe) companyId: string, @Query() query: AuditTrailQueryDto) {
    return this.billing.getAuditTrail(companyId, query);
  }


  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: RefundDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.refund(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('coupon')
  @HttpCode(HttpStatus.OK)
  applyCoupon(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: ApplyCouponDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.applyCoupon(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('manual-invoice')
  @HttpCode(HttpStatus.OK)
  createManualInvoice(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: ManualInvoiceDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.createManualInvoice(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('credit-note')
  @HttpCode(HttpStatus.OK)
  issueCreditNote(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreditNoteDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.issueCreditNote(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('retry-payment')
  @HttpCode(HttpStatus.OK)
  retryPayment(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: RetryPaymentDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.retryPayment(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  cancelSubscription(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CancelSubscriptionDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.cancelSubscription(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  /**
   * `cancel_for_cause` (Part 2): staff release of a company from the 12-month
   * minimum term. Audited, throttled, gated on BILLING_MANAGE. Not exposed in
   * the customer UI.
   */
  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('release-contract')
  @HttpCode(HttpStatus.OK)
  releaseFromContract(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: ReleaseContractDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.releaseFromContract(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post('reinstate')
  @HttpCode(HttpStatus.OK)
  reinstateSubscription(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.reinstateSubscription(companyId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }
}
