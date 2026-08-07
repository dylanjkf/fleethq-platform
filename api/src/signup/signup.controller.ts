import { Body, Controller, Get, Ip, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { SignupService } from './signup.service';
import { SignupDto } from './dto/signup.dto';

/**
 * Public self-serve signup (19-Billing/Self_Serve_Signup.md). All routes are
 * @Public() (no session — a prospective customer has no account yet) and
 * rate-limited to blunt automated abuse of a public, Stripe-touching endpoint.
 */
@Controller({ path: 'signup', version: '1' })
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  /** Pricing/config for the signup page's live price preview. */
  @Public()
  @Get('config')
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 30, ttl: 60_000 } })
  getConfig() {
    return this.signup.getSignupConfig();
  }

  /**
   * Starts a signup: validates, stages a pending_signup, and returns a Stripe
   * Checkout URL. No account is created here — provisioning happens on the
   * payment webhook. Rate-limited per IP.
   */
  @Public()
  @Post()
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 10, ttl: 60_000 } })
  create(@Body() dto: SignupDto, @Ip() ip: string, @Req() req: Request) {
    return this.signup.createSignupCheckout(dto, { ip, userAgent: req.get('user-agent') ?? null });
  }

  /**
   * Polled by the post-payment success page. Returns provisioning status and,
   * once complete, mints a login session (single-use) so the new admin lands
   * straight in the app. Rate-limited (the page polls it every ~2s).
   */
  @Public()
  @Get('status')
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 60, ttl: 60_000 } })
  status(@Query('sessionId') sessionId: string, @Ip() ip: string, @Req() req: Request) {
    return this.signup.getSignupStatus(sessionId, { ip, userAgent: req.get('user-agent') ?? null });
  }
}
