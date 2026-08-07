import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_READ_ONLY_KEY = 'allowWhenReadOnly';

/**
 * Marks a mutating route (or a whole controller) as still allowed while a
 * company is in the payment-failure read-only state. Reserved for the routes a
 * past-due customer MUST be able to reach to fix their billing — Checkout,
 * the customer portal, quantity changes, cancel/reinstate. Everything else that
 * writes tenant data is blocked by BillingReadOnlyGuard until payment succeeds.
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_WHEN_READ_ONLY_KEY, true);
