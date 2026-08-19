import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { INBOUND_WEBHOOK_THROTTLE } from '../common/throttles';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { AllowWhenReadOnly } from '../common/decorators/allow-when-read-only.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreatePortalSessionDto } from './dto/create-portal-session.dto';

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
  @AllowWhenReadOnly() // A past-due customer must be able to start a checkout to pay.
  createCheckoutSession(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateCheckoutSessionDto) {
    return this.billingService.createCheckoutSession(user.companyId, dto.priceId, dto.successUrl, dto.cancelUrl);
  }

  @Post('portal-session')
  @RequirePermission(PERMISSIONS.BILLING_MANAGE)
  @AllowWhenReadOnly() // The Stripe customer portal is how a past-due customer updates their card / retries payment.
  createPortalSession(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreatePortalSessionDto) {
    return this.billingService.createPortalSession(user.companyId, dto.returnUrl);
  }

  /**
   * Customer-initiated cancellation (Part 2). The ONLY self-serve cancel path —
   * the Stripe portal's own cancellation is disabled — so the 12-month minimum
   * term can gate it here. Returns CONTRACT_LOCKED (400) while within the term
   * when enforcement is enabled; otherwise cancels at period end.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.BILLING_MANAGE)
  cancelSubscription(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.billingService.cancelSubscription(user.companyId);
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
  // Signature verification is the real gate; this is a lightweight per-IP cap
  // for consistency with the other public webhook. Stripe retries on 429, so a
  // brief burst over the limit is redelivered rather than lost.
  @Throttle(INBOUND_WEBHOOK_THROTTLE)
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
