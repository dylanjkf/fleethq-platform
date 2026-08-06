import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreatePortalSessionDto } from './dto/create-portal-session.dto';
import { ChangeAssetQuantityDto } from './dto/change-asset-quantity.dto';

@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('status')
  @RequirePermission(PERMISSIONS.BILLING_VIEW)
  getStatus(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.billingService.getStatus(user.companyId);
  }

  /** The purchasable plan tiers for the in-app plan picker. */
  @Get('plans')
  @RequirePermission(PERMISSIONS.BILLING_VIEW)
  listPlans() {
    return this.billingService.listPlans();
  }

  /**
   * What the company's plan entitles it to (features + limits). No permission
   * gate — any authenticated user needs this to render the right UI, the same
   * way `/auth/me` returns their permissions.
   */
  @Get('entitlements')
  @AuthenticatedOnly()
  getEntitlements(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.entitlements.getForCompany(user.companyId);
  }

  @Post('checkout-session')
  @RequirePermission(PERMISSIONS.BILLING_MANAGE)
  createCheckoutSession(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateCheckoutSessionDto) {
    return this.billingService.createCheckoutSession(user.companyId, dto.priceId, dto.successUrl, dto.cancelUrl, dto.quantity ?? 1);
  }

  /**
   * Change the number of paid asset slots on the per-asset plan (buy more or
   * release). Prorated by Stripe; the server blocks reducing below current live
   * asset usage. The new cap is applied by the resulting subscription webhook.
   */
  @Post('quantity')
  @RequirePermission(PERMISSIONS.BILLING_MANAGE)
  changeAssetQuantity(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ChangeAssetQuantityDto) {
    return this.billingService.changeAssetQuantity(user.companyId, dto.quantity, user.userId);
  }

  @Post('portal-session')
  @RequirePermission(PERMISSIONS.BILLING_MANAGE)
  createPortalSession(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreatePortalSessionDto) {
    return this.billingService.createPortalSession(user.companyId, dto.returnUrl);
  }

  /**
   * Called by Stripe directly, never by a FleetOS client — @Public() because
   * there's no user session to authenticate here, but never trusted blindly:
   * BillingService.handleWebhookEvent verifies the Stripe-Signature header
   * against the raw body before acting on anything. req.rawBody exists
   * because main.ts passes `rawBody: true` to NestFactory.create specifically
   * for this route.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: RawBodyRequest<Request>) {
    const signature = req.headers['stripe-signature'];
    if (!req.rawBody || typeof signature !== 'string') {
      throw new BadRequestException({ code: 'INVALID_WEBHOOK_REQUEST', message: 'Missing raw body or Stripe-Signature header.' });
    }
    await this.billingService.handleWebhookEvent(req.rawBody, signature);
    return { received: true };
  }
}
