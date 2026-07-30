import { Module } from '@nestjs/common';
import { ImportsModule } from '../imports/imports.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationCryptoService } from './integration-crypto.service';
import { IntegrationCredentialsService } from './integration-credentials.service';
import { IntegrationConnectionsService } from './integration-connections.service';
import { IntegrationTransformService } from './integration-transform.service';
import { IntegrationMappingEngine } from './integration-mapping-engine.service';
import { IntegrationSyncEngine } from './integration-sync-engine.service';
import { IntegrationWebhookService } from './integration-webhook.service';

/**
 * The Integration Hub (10-Integrations/Integration_Hub.md): plugin-shaped
 * framework (credential vault, universal field mapping, sync engine,
 * webhooks in/out) plus three reference connectors (CSV, generic REST
 * poller, generic incoming webhook). Imports ImportsModule to reuse its
 * per-entity `create` paths for every sync — the Sync Engine never
 * reimplements entity validation.
 *
 * IntegrationSyncEngine is exported so SchedulerModule can run the
 * scheduled-sync and dead-letter-retry sweeps.
 */
@Module({
  imports: [ImportsModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationCryptoService,
    IntegrationCredentialsService,
    IntegrationConnectionsService,
    IntegrationTransformService,
    IntegrationMappingEngine,
    IntegrationSyncEngine,
    IntegrationWebhookService,
  ],
  exports: [IntegrationSyncEngine],
})
export class IntegrationsModule {}
