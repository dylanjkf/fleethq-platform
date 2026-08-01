import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AssetsModule } from './assets/assets.module';
import { OperatorsModule } from './operators/operators.module';
import { AttachedUnitsModule } from './attached-units/attached-units.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { LocationsModule } from './locations/locations.module';
import { DocumentsModule } from './documents/documents.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { MaintenanceSchedulesModule } from './maintenance-schedules/maintenance-schedules.module';
import { DashboardLayoutsModule } from './dashboard-layouts/dashboard-layouts.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SecuritySettingsModule } from './security-settings/security-settings.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ComplianceModule } from './compliance/compliance.module';
import { ChecklistsModule } from './checklists/checklists.module';
import { ChecklistBundlesModule } from './checklists/bundles/checklist-bundles.module';
import { AddressBooksModule } from './address-books/address-books.module';
import { AssetClassesModule } from './asset-classes/asset-classes.module';
import { GpsModule } from './gps/gps.module';
import { MessagesModule } from './messages/messages.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { TimelineModule } from './timeline/timeline.module';
import { CustomersModule } from './customers/customers.module';
import { DepotsModule } from './depots/depots.module';
import { ShiftsModule } from './shifts/shifts.module';
import { ImportsModule } from './imports/imports.module';
import { CompaniesModule } from './companies/companies.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { PrivacyModule } from './privacy/privacy.module';
import { SearchModule } from './search/search.module';
import { GraphModule } from './graph/graph.module';
import { FormsModule } from './forms/forms.module';
import { PredictiveMaintenanceModule } from './predictive-maintenance/predictive-maintenance.module';
import { OperationalRecommendationsModule } from './operational-recommendations/operational-recommendations.module';
import { PartsModule } from './parts/parts.module';
import { BillingModule } from './billing/billing.module';
import { FuelModule } from './fuel/fuel.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { BarcodeModule } from './barcode/barcode.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ContactModule } from './contact/contact.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminOrganisationsModule } from './admin-organisations/admin-organisations.module';
import { AdminCustomerUsersModule } from './admin-customer-users/admin-customer-users.module';
import { AdminAnalyticsModule } from './admin-analytics/admin-analytics.module';
import { AdminBillingModule } from './admin-billing/admin-billing.module';
import { AdminSupportModule } from './admin-support/admin-support.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { AdminFeatureFlagsModule } from './admin-feature-flags/admin-feature-flags.module';
import { AdminSystemModule } from './admin-system/admin-system.module';
import { AdminFleetModule } from './admin-fleet/admin-fleet.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ScopedThrottlerGuard } from './common/guards/scoped-throttler.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { FeatureGuard } from './common/guards/feature.guard';
import { FeatureFlagGuard } from './common/guards/feature-flag.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { DeprecationInterceptor } from './common/deprecation/deprecation.interceptor';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    // `validate` runs at boot: a missing DB URL / JWT secret (any env), or a
    // weak/placeholder JWT secret in production, crashes the process before it
    // serves a request — fail fast, never fail silently under-secured.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Structured (JSON) logging from day one so any log aggregator can
    // consume it later with zero rework — never plain-text console output.
    // Bearer tokens are redacted; nothing else about request bodies is
    // logged automatically (pino-http logs request metadata, not bodies).
    LoggerModule.forRoot({
      pinoHttp: {
        // End-to-end request correlation: honour an upstream request id (from a
        // load balancer / gateway) if present, else mint one; echo it back on
        // the response so a client can quote it in a bug report. pino-http then
        // stamps this id onto every log line for the request (`req.id`), and the
        // exception filter forwards it to Sentry — one id ties logs, the API
        // response, and the error event together.
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const header = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
          const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        // Jest sets NODE_ENV=test automatically — silent here so 20 tests'
        // worth of request logs don't drown out pass/fail output; the
        // structured logging itself is still exercised by real requests
        // against the dev server, not by this test-suite convenience.
        level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
        // Never let a credential or PII field reach the logs. Covers the auth
        // header/cookie plus common secret/PII keys at the log root and one
        // level down (the depth structured logs actually use here) — belt-and-
        // braces even though request bodies aren't logged automatically.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'password',
            'passwordHash',
            'newPassword',
            'token',
            'tokenHash',
            '*.password',
            '*.passwordHash',
            '*.newPassword',
            '*.token',
            '*.tokenHash',
          ],
          remove: true,
        },
      },
    }),
    // Per-IP rate limiting, applied globally with a generous default and
    // tightened per-route where it matters (login — see AuthController).
    // No backend previously existed at all; a bare NestJS app with no
    // rate limiting lets an internet-facing login endpoint be brute-forced
    // or credential-stuffed with no cost to the attacker. The e2e suite runs
    // hundreds of requests per file against one instance, so the limit is
    // effectively disabled under NODE_ENV=test — same convention the pino
    // logger config above already uses.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: process.env.NODE_ENV === 'test' ? 100_000 : 300,
      },
    ]),
    PrismaModule,
    AuthModule,
    AssetsModule,
    OperatorsModule,
    AttachedUnitsModule,
    DispatchModule,
    LocationsModule,
    DocumentsModule,
    KnowledgeModule,
    WarehouseModule,
    MaintenanceModule,
    MaintenanceSchedulesModule,
    DashboardLayoutsModule,
    AnalyticsModule,
    SecuritySettingsModule,
    ComplianceModule,
    ChecklistsModule,
    ChecklistBundlesModule,
    AddressBooksModule,
    AssetClassesModule,
    GpsModule,
    MessagesModule,
    AttachmentsModule,
    NotificationsModule,
    ReportsModule,
    TimelineModule,
    CustomersModule,
    DepotsModule,
    ShiftsModule,
    ImportsModule,
    CompaniesModule,
    UsersModule,
    RolesModule,
    PrivacyModule,
    SearchModule,
    GraphModule,
    FormsModule,
    PredictiveMaintenanceModule,
    OperationalRecommendationsModule,
    PartsModule,
    BillingModule,
    FuelModule,
    SchedulerModule,
    HealthModule,
    AuditModule,
    BarcodeModule,
    IntegrationsModule,
    ContactModule,
    AdminAuthModule,
    AdminOrganisationsModule,
    AdminCustomerUsersModule,
    AdminAnalyticsModule,
    AdminBillingModule,
    AdminSupportModule,
    AnnouncementsModule,
    FeatureFlagsModule,
    AdminFeatureFlagsModule,
    AdminSystemModule,
    AdminFleetModule,
  ],
  providers: [
    // Order matters: throttle first (cheapest check, rejects abuse before
    // spending a DB round trip on auth/permission checks), then authenticate,
    // then authorize. Applied globally — 12-API/API_Architecture.md: no route
    // is reachable without going through the same checks every other client
    // (internal or third-party) goes through.
    { provide: APP_GUARD, useClass: ScopedThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Paid-add-on paywall. Runs after permissions so "you can't do this at all"
    // (403) is answered before "your plan doesn't cover it" (402).
    { provide: APP_GUARD, useClass: FeatureGuard },
    // Admin-managed rollout switch (21-Admin-Platform/Overview.md, Phase 5b)
    // — a separate axis from FeatureGuard's billing entitlement check.
    { provide: APP_GUARD, useClass: FeatureFlagGuard },
    // Emits the RFC 8594 Deprecation/Sunset headers for any route marked
    // `@Deprecated(...)` (12-API/API_Versioning_Policy.md's "signal at runtime").
    // A no-op on undecorated routes.
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
