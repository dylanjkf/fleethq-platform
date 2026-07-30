import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { IntegrationWebhook, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { IntegrationCredentialsService } from './integration-credentials.service';
import { IntegrationSyncEngine } from './integration-sync-engine.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';

const SIGNATURE_HEADER = 'x-fleethq-signature';
/** Outgoing delivery is retried inline (bounded attempts, short backoff) rather than
 * rescheduled asynchronously — IntegrationWebhookDelivery is an append-only log with no
 * next-retry-at column to persist a queued retry against, unlike IntegrationDeadLetter.
 * A documented simplification: adequate for a handful of attempts against a normally-up
 * receiver; a genuinely offline endpoint just accumulates failed delivery log rows. */
const MAX_OUTGOING_ATTEMPTS = 5;
const OUTGOING_BACKOFF_BASE_MS = 200;
const OUTGOING_BACKOFF_CAP_MS = 5_000;


/**
 * Incoming (FleetHQ receives) and outgoing (FleetHQ sends) webhooks
 * (10-Integrations/Integration_Hub.md). Outgoing signs with HMAC-SHA256 over
 * the raw JSON body using the linked credential's decrypted secret; incoming
 * verifies the same way, mirroring the Stripe webhook pattern in
 * billing.controller.ts (raw body + signature check) but with FleetHQ's own
 * header/algorithm since there's no external SDK here.
 */
@Injectable()
export class IntegrationWebhookService {
  private readonly logger = new Logger(IntegrationWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly credentials: IntegrationCredentialsService,
    private readonly syncEngine: IntegrationSyncEngine,
    private readonly audit: AuditService,
  ) {}

  // ---- CRUD -----------------------------------------------------------------

  async create(companyId: string, input: CreateWebhookDto): Promise<IntegrationWebhook> {
    if (input.direction === 'OUTGOING' && !input.targetUrl?.trim()) {
      throw new BadRequestException({ code: 'INTEGRATION_WEBHOOK_TARGET_URL_REQUIRED', message: 'Outgoing webhooks require a targetUrl.' });
    }
    return this.prisma.withTenant(companyId, async (tx) => {
      if (input.connectionId) await this.requireConnectionExists(tx, companyId, input.connectionId);
      if (input.secretCredentialId) await this.requireCredentialExists(tx, companyId, input.secretCredentialId);
      // Unguessable inbound URL segment — 32 random bytes, base64url so it's
      // URL-safe with no padding to escape.
      const inboundToken = input.direction === 'INCOMING' ? randomBytes(32).toString('base64url') : undefined;
      return tx.integrationWebhook.create({
        data: {
          companyId,
          name: input.name,
          direction: input.direction,
          connectionId: input.connectionId,
          targetUrl: input.targetUrl,
          inboundToken,
          secretCredentialId: input.secretCredentialId,
          headerTemplate: input.headerTemplate as Prisma.InputJsonValue | undefined,
          isEnabled: input.isEnabled ?? true,
        },
      });
    });
  }

  async list(companyId: string, includeArchived: boolean): Promise<{ items: IntegrationWebhook[] }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.integrationWebhook.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return { items };
    });
  }

  async update(companyId: string, id: string, input: UpdateWebhookDto): Promise<IntegrationWebhook> {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireWebhookTx(tx, companyId, id);
      if (input.secretCredentialId) await this.requireCredentialExists(tx, companyId, input.secretCredentialId);
      return tx.integrationWebhook.update({
        where: { id },
        data: {
          name: input.name,
          targetUrl: input.targetUrl === undefined ? undefined : input.targetUrl,
          secretCredentialId: input.secretCredentialId === undefined ? undefined : input.secretCredentialId,
          headerTemplate:
            input.headerTemplate === undefined
              ? undefined
              : input.headerTemplate === null
                ? Prisma.JsonNull
                : (input.headerTemplate as Prisma.InputJsonValue),
          isEnabled: input.isEnabled,
        },
      });
    });
  }

  async archive(companyId: string, id: string): Promise<IntegrationWebhook> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireWebhookTx(tx, companyId, id);
      if (existing.archivedAt) return existing;
      return tx.integrationWebhook.update({ where: { id }, data: { archivedAt: new Date(), isEnabled: false } });
    });
  }

  async listDeliveries(companyId: string, webhookId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireWebhookTx(tx, companyId, webhookId);
      const items = await tx.integrationWebhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: 'desc' }, take: 200 });
      return { items };
    });
  }

  async requireWebhook(companyId: string, id: string): Promise<IntegrationWebhook> {
    return this.prisma.withTenant(companyId, (tx) => this.requireWebhookTx(tx, companyId, id));
  }

  // ---- Test-send --------------------------------------------------------------

  async test(companyId: string, id: string): Promise<{ mode: 'outgoing'; success: boolean; attempts: number } | { mode: 'incoming'; inboundToken: string | null }> {
    const webhook = await this.requireWebhook(companyId, id);
    if (webhook.direction === 'OUTGOING') {
      const result = await this.dispatch(companyId, id, { test: true, sentAt: new Date().toISOString() });
      return { mode: 'outgoing', ...result };
    }
    return { mode: 'incoming', inboundToken: webhook.inboundToken };
  }

  // ---- Outgoing ---------------------------------------------------------------

  /** POSTs `payload` to the webhook's targetUrl, signed and logged. Retries inline on failure (see MAX_OUTGOING_ATTEMPTS doc). */
  async dispatch(companyId: string, webhookId: string, payload: Record<string, unknown>): Promise<{ success: boolean; attempts: number }> {
    const webhook = await this.requireWebhook(companyId, webhookId);
    if (webhook.direction !== 'OUTGOING' || !webhook.targetUrl) {
      throw new BadRequestException({ code: 'INTEGRATION_WEBHOOK_NOT_OUTGOING', message: 'Webhook is not configured for outgoing delivery.' });
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((webhook.headerTemplate as Record<string, string> | null) ?? {}),
    };
    if (webhook.secretCredentialId) {
      const { secretValue } = await this.credentials.getDecryptedSecret(companyId, webhook.secretCredentialId);
      headers[SIGNATURE_HEADER] = createHmac('sha256', secretValue).update(body).digest('hex');
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_OUTGOING_ATTEMPTS; attempt++) {
      let responseStatus: number | undefined;
      let success = false;
      let errorMessage: string | undefined;
      try {
        const response = await fetch(webhook.targetUrl, { method: 'POST', headers, body });
        responseStatus = response.status;
        success = response.ok;
        if (!success) errorMessage = `Non-2xx response: ${response.status}`;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : 'Request failed.';
      }

      await this.prisma.withTenant(companyId, (tx) =>
        tx.integrationWebhookDelivery.create({
          data: { companyId, webhookId, direction: 'OUTGOING', requestPayload: payload as Prisma.InputJsonValue, responseStatus, success, attempt, errorMessage },
        }),
      );

      if (success) {
        await this.prisma.withTenant(companyId, (tx) => tx.integrationWebhook.update({ where: { id: webhookId }, data: { lastTriggeredAt: new Date() } }));
        return { success: true, attempts: attempt };
      }
      lastError = errorMessage;
      if (attempt < MAX_OUTGOING_ATTEMPTS) {
        await this.sleep(Math.min(OUTGOING_BACKOFF_CAP_MS, OUTGOING_BACKOFF_BASE_MS * 2 ** (attempt - 1)));
      }
    }
    this.logger.warn(`Outgoing webhook ${webhookId} failed after ${MAX_OUTGOING_ATTEMPTS} attempts: ${lastError}`);
    return { success: false, attempts: MAX_OUTGOING_ATTEMPTS };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- Incoming -----------------------------------------------------------------

  /**
   * The public inbound receiver. Throws NotFoundException for an unknown
   * token and UnauthorizedException for a signature mismatch (the controller
   * lets those map to 404/401 normally); otherwise always resolves — a
   * malformed payload or a downstream mapping failure becomes a delivery-log
   * row / dead letter, never a non-2xx response, so an external sender never
   * retry-storms this endpoint.
   */
  async handleIncoming(token: string, rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
    const webhook = await this.findWebhookByToken(token);
    if (!webhook) {
      throw new NotFoundException({ code: 'INTEGRATION_WEBHOOK_NOT_FOUND', message: 'Unknown webhook token.' });
    }

    if (webhook.secretCredentialId) {
      const { secretValue } = await this.credentials.getDecryptedSecret(webhook.companyId, webhook.secretCredentialId);
      const expected = createHmac('sha256', secretValue).update(rawBody).digest('hex');
      const provided = signatureHeader ?? '';
      const valid = provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      if (!valid) {
        await this.recordDelivery(webhook.companyId, webhook.id, undefined, false, 'Invalid signature');
        throw new UnauthorizedException({ code: 'INTEGRATION_WEBHOOK_INVALID_SIGNATURE', message: 'Signature verification failed.' });
      }
    }

    let payload: Record<string, unknown> = {};
    let parseError: string | undefined;
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      parseError = 'Invalid JSON payload';
    }

    await this.recordDelivery(webhook.companyId, webhook.id, parseError ? undefined : payload, !parseError, parseError);
    await this.prisma.withTenant(webhook.companyId, (tx) => tx.integrationWebhook.update({ where: { id: webhook.id }, data: { lastTriggeredAt: new Date() } }));

    if (!parseError && webhook.connectionId) {
      try {
        // Recorded as a MANUAL sync — the schema's IntegrationSyncTrigger enum
        // has no WEBHOOK value, so this is the closest existing one (documented
        // simplification; the SyncRun itself is still traceable to this webhook
        // via its connectionId + timing against the delivery log).
        await this.syncEngine.runSync(webhook.companyId, webhook.connectionId, 'MANUAL', undefined, [payload]);
      } catch (err) {
        this.logger.error(`Webhook-triggered sync failed for connection ${webhook.connectionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.audit.record(webhook.companyId, {
      action: AUDIT_ACTIONS.INTEGRATION_WEBHOOK_RECEIVED,
      targetType: 'IntegrationWebhook',
      targetId: webhook.id,
      outcome: parseError ? 'failure' : 'success',
      metadata: { connectionId: webhook.connectionId ?? null },
    });
  }

  private async recordDelivery(companyId: string, webhookId: string, payload: Record<string, unknown> | undefined, success: boolean, errorMessage: string | undefined) {
    await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationWebhookDelivery.create({
        data: {
          companyId,
          webhookId,
          direction: 'INCOMING',
          requestPayload: payload as Prisma.InputJsonValue | undefined,
          success,
          attempt: 1,
          errorMessage,
        },
      }),
    );
  }

  /**
   * Finds which company owns an inbound token. IntegrationWebhook is
   * RLS-protected by company_id (like every other tenant table), and there's
   * no tenant context yet on this public route — unlike the auth-login
   * lookup, there's no narrow BYPASSRLS grant for this table (SystemPrismaService
   * is deliberately restricted to users/companies only; a schema/migration
   * change to add one was out of scope here). So this fans out across active
   * companies via the same already-established `listActiveCompanyIds` +
   * per-company `withTenant` idiom the scheduler uses, stopping at the first
   * match. O(active companies) per inbound request — acceptable at this
   * milestone's scale, but flagged as a follow-up: a dedicated non-RLS
   * token->company lookup (or a SECURITY DEFINER function) would make this
   * O(1) once a migration for it is in scope.
   */
  private async findWebhookByToken(token: string): Promise<IntegrationWebhook | null> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    for (const companyId of companyIds) {
      const found = await this.prisma.withTenant(companyId, (tx) =>
        tx.integrationWebhook.findFirst({ where: { inboundToken: token, isEnabled: true, archivedAt: null } }),
      );
      if (found) return found;
    }
    return null;
  }

  // ---- helpers --------------------------------------------------------------

  private async requireWebhookTx(tx: Prisma.TransactionClient, companyId: string, id: string): Promise<IntegrationWebhook> {
    const row = await tx.integrationWebhook.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_WEBHOOK_NOT_FOUND', message: 'Webhook not found.' });
    }
    return row;
  }

  private async requireConnectionExists(tx: Prisma.TransactionClient, companyId: string, id: string): Promise<void> {
    const row = await tx.integrationConnection.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_CONNECTION_NOT_FOUND', message: 'Connection not found.' });
    }
  }

  private async requireCredentialExists(tx: Prisma.TransactionClient, companyId: string, id: string): Promise<void> {
    const row = await tx.integrationCredential.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId || row.archivedAt) {
      throw new NotFoundException({ code: 'INTEGRATION_CREDENTIAL_NOT_FOUND', message: 'Credential not found.' });
    }
  }
}
