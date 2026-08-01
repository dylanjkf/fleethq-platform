import { Module } from '@nestjs/common';
import { AdminBillingController } from './admin-billing.controller';
import { AdminBillingService } from './admin-billing.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { BillingModule } from '../billing/billing.module';

/**
 * Imports the customer-facing BillingModule for `BillingService.getStripeClient()`
 * / `isConfigured()` — this module never opens a second Stripe SDK instance,
 * see AdminBillingService's own docstring for why. AdminAuditModule is
 * required by AdminPermissionGuard's DI (every AdminGuarded() controller's
 * module needs it — see the Phase 3 DI-resolution gotcha this codebase
 * hit once already).
 */
@Module({
  imports: [AdminAuditModule, BillingModule],
  controllers: [AdminBillingController],
  providers: [AdminBillingService],
  exports: [AdminBillingService],
})
export class AdminBillingModule {}
