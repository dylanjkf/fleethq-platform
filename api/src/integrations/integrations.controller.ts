import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { INBOUND_WEBHOOK_THROTTLE } from '../common/throttles';
import { IntegrationCredentialsService } from './integration-credentials.service';
import { IntegrationConnectionsService } from './integration-connections.service';
import { IntegrationSyncEngine } from './integration-sync-engine.service';
import { IntegrationWebhookService } from './integration-webhook.service';
import { CreateCredentialDto } from './dto/create-credential.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { CreateFieldMappingDto, UpdateFieldMappingDto } from './dto/field-mapping.dto';
import { SyncConnectionDto } from './dto/sync-connection.dto';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';

/**
 * Integration Hub API (10-Integrations/Integration_Hub.md). Every route is
 * `integrations:view` (read) or `integrations:manage` (everything else),
 * except the public inbound webhook receiver — that one has no user session
 * to authenticate (an external system calls it directly) and is instead
 * guarded by its own signature check inside IntegrationWebhookService,
 * mirroring billing.controller.ts's Stripe webhook route.
 */
@Controller({ path: 'integrations', version: '1' })
export class IntegrationsController {
  constructor(
    private readonly credentials: IntegrationCredentialsService,
    private readonly connections: IntegrationConnectionsService,
    private readonly syncEngine: IntegrationSyncEngine,
    private readonly webhooks: IntegrationWebhookService,
  ) {}

  // ---- Credentials ------------------------------------------------------------

  @Get('credentials')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  listCredentials(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.credentials.list(user.companyId, query.includeArchived ?? false);
  }

  @Post('credentials')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  createCredential(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateCredentialDto) {
    return this.credentials.create(user.companyId, user.userId, dto);
  }

  @Patch('credentials/:id')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  updateCredential(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCredentialDto) {
    return this.credentials.update(user.companyId, id, dto);
  }

  @Post('credentials/:id/archive')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  archiveCredential(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credentials.archive(user.companyId, id);
  }

  @Post('credentials/:id/test')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  testCredential(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credentials.test(user.companyId, id);
  }

  // ---- Connections --------------------------------------------------------------

  @Get('connections')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  listConnections(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.connections.list(user.companyId, query.includeArchived ?? false);
  }

  @Get('connections/:id')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  getConnection(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(user.companyId, id);
  }

  @Post('connections')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  createConnection(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateConnectionDto) {
    return this.connections.create(user.companyId, user.userId, dto);
  }

  @Patch('connections/:id')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  updateConnection(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConnectionDto) {
    return this.connections.update(user.companyId, id, dto);
  }

  @Post('connections/:id/archive')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  archiveConnection(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.archive(user.companyId, id);
  }

  // ---- Field mappings ------------------------------------------------------------

  @Get('connections/:id/field-mappings')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  listFieldMappings(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.listFieldMappings(user.companyId, id);
  }

  @Post('connections/:id/field-mappings')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  createFieldMapping(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFieldMappingDto) {
    return this.connections.createFieldMapping(user.companyId, id, dto);
  }

  @Patch('field-mappings/:id')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  updateFieldMapping(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFieldMappingDto) {
    return this.connections.updateFieldMapping(user.companyId, id, dto);
  }

  @Post('field-mappings/:id/archive')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  archiveFieldMapping(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.archiveFieldMapping(user.companyId, id);
  }

  // ---- Sync -----------------------------------------------------------------------

  @Post('connections/:id/sync')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  triggerSync(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncConnectionDto) {
    return this.syncEngine.runSync(user.companyId, id, 'MANUAL', user.userId, dto.rows);
  }

  @Get('connections/:id/sync-runs')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  async listSyncRuns(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListQueryDto) {
    await this.connections.requireConnection(user.companyId, id);
    return this.connections.listSyncRuns(user.companyId, id, query.skip, query.take);
  }

  @Get('connections/:id/dead-letters')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  async listDeadLetters(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListQueryDto) {
    await this.connections.requireConnection(user.companyId, id);
    return this.connections.listDeadLetters(user.companyId, id, query.skip, query.take);
  }

  @Post('dead-letters/:id/retry')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  retryDeadLetter(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.syncEngine.retryDeadLetterById(user.companyId, id);
  }

  // ---- Dashboard --------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  dashboard(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.connections.dashboard(user.companyId);
  }

  // ---- Webhooks -------------------------------------------------------------------

  @Get('webhooks')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  listWebhooks(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.webhooks.list(user.companyId, query.includeArchived ?? false);
  }

  @Post('webhooks')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  createWebhook(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateWebhookDto) {
    return this.webhooks.create(user.companyId, dto);
  }

  @Patch('webhooks/:id')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  updateWebhook(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWebhookDto) {
    return this.webhooks.update(user.companyId, id, dto);
  }

  @Post('webhooks/:id/archive')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  archiveWebhook(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.archive(user.companyId, id);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_VIEW)
  listWebhookDeliveries(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.listDeliveries(user.companyId, id);
  }

  @Post('webhooks/:id/test')
  @RequirePermission(PERMISSIONS.INTEGRATIONS_MANAGE)
  testWebhook(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.test(user.companyId, id);
  }

  /**
   * The public inbound receiver — called by an external system, never by a
   * FleetHQ client. @Public() because there's no user session to
   * authenticate; IntegrationWebhookService.handleIncoming verifies the
   * signature (when configured) against the raw body before acting, the same
   * way BillingController's Stripe webhook does. req.rawBody exists because
   * main.ts passes `rawBody: true` to NestFactory.create for exactly this
   * kind of route.
   */
  @Public()
  @Throttle(INBOUND_WEBHOOK_THROTTLE)
  @Post('webhooks/in/:token')
  @HttpCode(HttpStatus.OK)
  async receiveInboundWebhook(@Param('token') token: string, @Req() req: RawBodyRequest<Request>) {
    const signature = req.headers['x-fleethq-signature'];
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    await this.webhooks.handleIncoming(token, rawBody, typeof signature === 'string' ? signature : undefined);
    return { received: true };
  }
}
