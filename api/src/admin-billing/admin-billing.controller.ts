import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminBillingService } from './admin-billing.service';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { RefundDto } from './dto/refund.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { ManualInvoiceDto } from './dto/manual-invoice.dto';
import { CreditNoteDto } from './dto/credit-note.dto';
import { RetryPaymentDto } from './dto/retry-payment.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/organisations/:companyId/billing', version: '1' })
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_VIEW)
  @Get()
  getStatus(@Param('companyId') companyId: string) {
    return this.billing.getStatus(companyId);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_VIEW)
  @Get('invoices')
  listInvoices(@Param('companyId') companyId: string, @Query() query: ListInvoicesQueryDto) {
    return this.billing.listInvoices(companyId, query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @Param('companyId') companyId: string,
    @Body() dto: RefundDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.refund(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('coupon')
  @HttpCode(HttpStatus.OK)
  applyCoupon(
    @Param('companyId') companyId: string,
    @Body() dto: ApplyCouponDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.applyCoupon(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('manual-invoice')
  @HttpCode(HttpStatus.OK)
  createManualInvoice(
    @Param('companyId') companyId: string,
    @Body() dto: ManualInvoiceDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.createManualInvoice(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('credit-note')
  @HttpCode(HttpStatus.OK)
  issueCreditNote(
    @Param('companyId') companyId: string,
    @Body() dto: CreditNoteDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.issueCreditNote(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('retry-payment')
  @HttpCode(HttpStatus.OK)
  retryPayment(
    @Param('companyId') companyId: string,
    @Body() dto: RetryPaymentDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.retryPayment(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  cancelSubscription(
    @Param('companyId') companyId: string,
    @Body() dto: CancelSubscriptionDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.cancelSubscription(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.BILLING_MANAGE)
  @Post('reinstate')
  @HttpCode(HttpStatus.OK)
  reinstateSubscription(
    @Param('companyId') companyId: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.billing.reinstateSubscription(companyId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }
}
