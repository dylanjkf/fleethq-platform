import { Module } from '@nestjs/common';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { BillingModule } from '../billing/billing.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/**
 * Imports AdminAuditModule for `AdminPermissionGuard`'s own dependency
 * (denial recording) — every module whose controllers use `AdminGuarded()`
 * needs this. Also imports the customer-facing BillingModule for
 * `BillingService.getPriceUnitAmounts` — a stateless, tenant-independent
 * Stripe catalog lookup (not customer billing data), reused for MRR/ARR the
 * same way Phase 2 reused AuthService for impersonation.
 */
@Module({
  imports: [AdminAuditModule, BillingModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService],
})
export class AdminAnalyticsModule {}
