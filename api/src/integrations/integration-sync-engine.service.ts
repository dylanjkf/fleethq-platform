import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationAuthType, IntegrationDeadLetter, IntegrationSyncStatus, IntegrationSyncTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { ImportsService, ImportResult } from '../imports/imports.service';
import { ImportRowResult } from '../common/imports/import-helpers';
import { IntegrationMappingEngine } from './integration-mapping-engine.service';
import { IntegrationCredentialsService } from './integration-credentials.service';
import { computeNextCronRun } from './integration-cron.util';
import { TargetEntity } from './dto/allowed-target-entities';
import { safeFetch, SsrfBlockedError } from '../common/net/safe-fetch';

/** Dead-letter retry backoff: 2^attempts minutes, capped at one day. Documented constants — not configurable per task scope. */
const MAX_DEAD_LETTER_ATTEMPTS = 5;
const RETRY_BACKOFF_BASE_MINUTES = 2;
const RETRY_BACKOFF_CAP_MINUTES = 24 * 60;

type ImportDispatch = (
  companyId: string,
  actorUserId: string | undefined,
  dto: { rows: Record<string, unknown>[]; dryRun?: boolean },
) => Promise<ImportResult>;

/**
 * The Sync Engine (10-Integrations/Integration_Hub.md): fetches/accepts rows
 * from a connector, maps each through the Universal Data Mapping Engine, and
 * creates FleetHQ records via the EXACT same per-entity `create` path the bulk
 * `imports` module already uses — no per-entity validation is reimplemented
 * here. One bad row becomes a dead letter, never an aborted batch (mirrors
 * SchedulerService's per-item try/catch idiom).
 */
@Injectable()
export class IntegrationSyncEngine {
  private readonly logger = new Logger(IntegrationSyncEngine.name);
  private readonly importDispatch: Record<TargetEntity, ImportDispatch>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imports: ImportsService,
    private readonly mappingEngine: IntegrationMappingEngine,
    private readonly credentials: IntegrationCredentialsService,
  ) {
    this.importDispatch = {
      assets: (c, a, d) => this.imports.importAssets(c, a, d),
      operators: (c, a, d) => this.imports.importOperators(c, a, d),
      depots: (c, a, d) => this.imports.importDepots(c, a, d),
      customers: (c, a, d) => this.imports.importCustomers(c, a, d),
      attached_units: (c, a, d) => this.imports.importAttachedUnits(c, a, d),
      compliance_documents: (c, a, d) => this.imports.importComplianceDocuments(c, a, d),
    };
  }

  /**
   * Runs one sync. `rows` is the CSV/webhook connector's already-resolved
   * external rows (undefined/ignored for REST, which fetches its own). Always
   * resolves — a connector-level failure (bad URL, auth failure) is recorded
   * as a FAILURE sync run rather than thrown, so callers (controller, webhook
   * receiver, scheduler sweep) never need their own try/catch around this.
   */
  async runSync(
    companyId: string,
    connectionId: string,
    trigger: IntegrationSyncTrigger,
    triggeredByUserId?: string,
    rows?: Record<string, unknown>[],
  ) {
    const connection = await this.prisma.withTenant(companyId, (tx) => tx.integrationConnection.findUnique({ where: { id: connectionId } }));
    if (!connection || connection.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_CONNECTION_NOT_FOUND', message: 'Integration connection not found.' });
    }

    const syncRun = await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationSyncRun.create({
        data: { companyId, connectionId, trigger, status: 'RUNNING', triggeredByUserId: triggeredByUserId ?? null },
      }),
    );

    let externalRows: Record<string, unknown>[];
    try {
      externalRows = await this.resolveExternalRows(companyId, connection, rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch rows from the external system.';
      await this.finishRun(companyId, connectionId, syncRun.id, 'FAILURE', 0, 0, 0, message, triggeredByUserId);
      return this.prisma.withTenant(companyId, (tx) => tx.integrationSyncRun.findUniqueOrThrow({ where: { id: syncRun.id } }));
    }

    const fieldMappings = await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationFieldMapping.findMany({ where: { connectionId, archivedAt: null }, orderBy: { order: 'asc' } }),
    );

    let succeeded = 0;
    let failed = 0;
    const mappedBatch: { externalRow: Record<string, unknown>; mapped: Record<string, unknown> }[] = [];

    for (const externalRow of externalRows) {
      const { mapped, missingRequiredFields } = this.mappingEngine.map(fieldMappings, externalRow);
      if (missingRequiredFields.length > 0) {
        failed++;
        await this.createDeadLetter(companyId, connectionId, syncRun.id, externalRow, `Missing required field(s): ${missingRequiredFields.join(', ')}`);
        continue;
      }
      mappedBatch.push({ externalRow, mapped });
    }

    if (mappedBatch.length > 0) {
      const counts = await this.dispatchMappedBatch(companyId, connectionId, syncRun.id, connection.targetEntity as TargetEntity, triggeredByUserId, mappedBatch);
      succeeded += counts.succeeded;
      failed += counts.failed;
    }

    const recordsProcessed = externalRows.length;
    const status: IntegrationSyncStatus = failed === 0 ? 'SUCCESS' : succeeded === 0 && recordsProcessed > 0 ? 'FAILURE' : 'PARTIAL_FAILURE';
    await this.finishRun(companyId, connectionId, syncRun.id, status, recordsProcessed, succeeded, failed, undefined, triggeredByUserId);
    return this.prisma.withTenant(companyId, (tx) => tx.integrationSyncRun.findUniqueOrThrow({ where: { id: syncRun.id } }));
  }

  // ---- Connector: resolving external rows -----------------------------------

  private async resolveExternalRows(
    companyId: string,
    connection: { connectorType: string; config: Prisma.JsonValue; credentialId: string | null },
    rows?: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (connection.connectorType !== 'REST') {
      // CSV: rows are parsed client-side and posted directly (matches the
      // bulk `imports` module). WEBHOOK-as-sync-source: the single payload row
      // was already resolved by IntegrationWebhookService before runSync was called.
      return rows ?? [];
    }

    const config = (connection.config as Record<string, unknown>) ?? {};
    const url = typeof config.url === 'string' ? config.url : undefined;
    if (!url) throw new Error('REST connector is missing config.url.');

    const headers: Record<string, string> = {};
    if (connection.credentialId) {
      const { authType, secretValue } = await this.credentials.getDecryptedSecret(companyId, connection.credentialId);
      this.applyAuth(headers, authType, secretValue, config);
    }

    // safeFetch (not bare fetch): `url` is tenant-supplied, so it must be
    // validated against the SSRF blocklist before we make a request from
    // inside our own network — otherwise a connector pointed at the cloud
    // metadata endpoint or an internal host would faithfully import that
    // response into ordinary FleetHQ records via the mapping engine.
    let response: Response;
    try {
      response = await safeFetch(url, { method: 'GET', headers });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new BadRequestException({ code: 'INTEGRATION_URL_NOT_ALLOWED', message: err.message });
      }
      throw err;
    }
    if (!response.ok) {
      throw new Error(`REST connector request failed: ${response.status} ${response.statusText}`);
    }
    const body: unknown = await response.json();
    const arrayPath = typeof config.responseArrayPath === 'string' ? config.responseArrayPath : undefined;
    const extracted = arrayPath ? this.readPath(body, arrayPath) : body;
    if (!Array.isArray(extracted)) {
      throw new Error('REST response did not contain an array of rows at the configured responseArrayPath.');
    }
    return extracted as Record<string, unknown>[];
  }

  private applyAuth(headers: Record<string, string>, authType: IntegrationAuthType, secretValue: string, config: Record<string, unknown>): void {
    switch (authType) {
      case 'API_KEY': {
        const headerName = typeof config.apiKeyHeader === 'string' ? config.apiKeyHeader : 'X-API-Key';
        headers[headerName] = secretValue;
        break;
      }
      case 'BEARER_TOKEN':
        headers.Authorization = `Bearer ${secretValue}`;
        break;
      case 'BASIC_AUTH':
        // secretValue is stored as "username:password" — see the credential's create-time doc.
        headers.Authorization = `Basic ${Buffer.from(secretValue).toString('base64')}`;
        break;
      default:
        break; // NONE / WEBHOOK_SECRET — nothing to add to an outbound REST poll's auth.
    }
  }

  private readPath(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
  }

  // ---- Finishing a run --------------------------------------------------------

  private async finishRun(
    companyId: string,
    connectionId: string,
    syncRunId: string,
    status: IntegrationSyncStatus,
    recordsProcessed: number,
    recordsSucceeded: number,
    recordsFailed: number,
    errorSummary: string | undefined,
    triggeredByUserId?: string,
  ): Promise<void> {
    const finishedAt = new Date();
    await this.prisma.withTenant(companyId, async (tx) => {
      await tx.integrationSyncRun.update({
        where: { id: syncRunId },
        data: { status, recordsProcessed, recordsSucceeded, recordsFailed, errorSummary, finishedAt },
      });
      await tx.integrationConnection.update({ where: { id: connectionId }, data: { lastSyncAt: finishedAt, lastSyncStatus: status } });
    });
    await this.audit.record(companyId, {
      action: AUDIT_ACTIONS.INTEGRATION_SYNC_COMPLETED,
      actorUserId: triggeredByUserId ?? null,
      targetType: 'IntegrationConnection',
      targetId: connectionId,
      outcome: status === 'FAILURE' ? 'failure' : 'success',
      metadata: { recordsProcessed, recordsSucceeded, recordsFailed, status },
    });
    this.logger.log(`Sync run ${syncRunId} finished: ${status} (${recordsSucceeded}/${recordsProcessed} succeeded).`);
  }

  private backoffFrom(attempts: number): Date {
    const minutes = Math.min(RETRY_BACKOFF_CAP_MINUTES, RETRY_BACKOFF_BASE_MINUTES ** attempts);
    return new Date(Date.now() + minutes * 60_000);
  }

  private async dispatchMappedBatch(
    companyId: string,
    connectionId: string,
    syncRunId: string,
    targetEntity: TargetEntity,
    triggeredByUserId: string | undefined,
    mappedBatch: { externalRow: Record<string, unknown>; mapped: Record<string, unknown> }[],
  ): Promise<{ succeeded: number; failed: number }> {
    const dispatch = this.importDispatch[targetEntity];
    if (!dispatch) {
      for (const { externalRow } of mappedBatch) {
        await this.createDeadLetter(companyId, connectionId, syncRunId, externalRow, `Unknown target entity "${targetEntity}".`);
      }
      return { succeeded: 0, failed: mappedBatch.length };
    }
    const result = await dispatch(companyId, triggeredByUserId, { rows: mappedBatch.map((b) => b.mapped), dryRun: false });
    let succeeded = 0;
    let failed = 0;
    for (const rowResult of result.rows) {
      if (rowResult.created) {
        succeeded++;
      } else {
        failed++;
        await this.recordRowFailure(companyId, connectionId, syncRunId, mappedBatch[rowResult.index], rowResult);
      }
    }
    return { succeeded, failed };
  }

  private async recordRowFailure(
    companyId: string,
    connectionId: string,
    syncRunId: string,
    original: { externalRow: Record<string, unknown>; mapped: Record<string, unknown> },
    rowResult: ImportRowResult,
  ): Promise<void> {
    await this.createDeadLetter(
      companyId,
      connectionId,
      syncRunId,
      original.externalRow,
      rowResult.errors.join('; ') || 'Row failed validation.',
    );
  }

  private async createDeadLetter(
    companyId: string,
    connectionId: string,
    syncRunId: string,
    rawPayload: Record<string, unknown>,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationDeadLetter.create({
        data: {
          companyId,
          connectionId,
          syncRunId,
          rawPayload: rawPayload as Prisma.InputJsonValue,
          errorMessage,
          attempts: 1,
          status: 'PENDING_RETRY',
          nextRetryAt: this.backoffFrom(1),
        },
      }),
    );
  }

  // ---- Scheduled sweeps (called from SchedulerService, per company) ---------

  /** Runs every enabled connection whose nextRunAt has arrived; always advances nextRunAt afterward. */
  async runDueScheduledSyncsForCompany(companyId: string): Promise<{ ran: number; failures: number }> {
    const due = await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationConnection.findMany({ where: { isEnabled: true, archivedAt: null, nextRunAt: { lte: new Date() } } }),
    );
    let ran = 0;
    let failures = 0;
    for (const connection of due) {
      try {
        await this.runSync(companyId, connection.id, 'SCHEDULED');
        ran++;
      } catch (err) {
        failures++;
        this.logger.error(`Scheduled sync failed for connection ${connection.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Always advance nextRunAt (success or failure) — a permanently-broken
      // connector must not fire every scheduler tick forever; its failures
      // surface in the Sync Dashboard / Error Centre instead.
      const next = connection.scheduleCron ? computeNextCronRun(connection.scheduleCron, new Date()) : null;
      await this.prisma
        .withTenant(companyId, (tx) => tx.integrationConnection.update({ where: { id: connection.id }, data: { nextRunAt: next } }))
        .catch((err) => this.logger.error(`Failed to advance nextRunAt for connection ${connection.id}: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { ran, failures };
  }

  /** Retries every PENDING_RETRY dead letter whose backoff has elapsed, one row at a time. */
  async retryDueDeadLettersForCompany(companyId: string): Promise<{ retried: number; resolved: number; failed: number }> {
    const due = await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationDeadLetter.findMany({ where: { status: 'PENDING_RETRY', nextRetryAt: { lte: new Date() } } }),
    );
    let resolved = 0;
    let failed = 0;
    for (const deadLetter of due) {
      try {
        const outcome = await this.retryDeadLetter(companyId, deadLetter);
        if (outcome === 'RESOLVED') resolved++;
        else failed++;
      } catch (err) {
        failed++;
        this.logger.error(`Dead letter retry failed for ${deadLetter.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { retried: due.length, resolved, failed };
  }

  /** Manual "retry now" — the same single-row retry path, callable directly from the Error Centre. */
  async retryDeadLetterById(companyId: string, id: string) {
    const deadLetter = await this.prisma.withTenant(companyId, (tx) => tx.integrationDeadLetter.findUnique({ where: { id } }));
    if (!deadLetter || deadLetter.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_DEAD_LETTER_NOT_FOUND', message: 'Dead letter not found.' });
    }
    await this.retryDeadLetter(companyId, deadLetter);
    return this.prisma.withTenant(companyId, (tx) => tx.integrationDeadLetter.findUniqueOrThrow({ where: { id } }));
  }

  /** Single dead-letter retry — shared by the sweep and the manual endpoint. */
  private async retryDeadLetter(
    companyId: string,
    deadLetter: Pick<IntegrationDeadLetter, 'id' | 'connectionId' | 'rawPayload' | 'attempts'>,
  ): Promise<'RESOLVED' | 'FAILED' | 'DEAD'> {
    const connection = await this.prisma.withTenant(companyId, (tx) => tx.integrationConnection.findUnique({ where: { id: deadLetter.connectionId } }));
    if (!connection) {
      await this.prisma.withTenant(companyId, (tx) =>
        tx.integrationDeadLetter.update({ where: { id: deadLetter.id }, data: { status: 'DEAD', errorMessage: 'Parent connection no longer exists.', nextRetryAt: null } }),
      );
      return 'DEAD';
    }

    const fieldMappings = await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationFieldMapping.findMany({ where: { connectionId: connection.id, archivedAt: null }, orderBy: { order: 'asc' } }),
    );
    const rawPayload = (deadLetter.rawPayload as Record<string, unknown>) ?? {};
    const { mapped, missingRequiredFields } = this.mappingEngine.map(fieldMappings, rawPayload);
    if (missingRequiredFields.length > 0) {
      return this.bumpDeadLetterAttempt(companyId, deadLetter.id, deadLetter.attempts, `Missing required field(s): ${missingRequiredFields.join(', ')}`);
    }

    const dispatch = this.importDispatch[connection.targetEntity as TargetEntity];
    if (!dispatch) {
      return this.bumpDeadLetterAttempt(companyId, deadLetter.id, deadLetter.attempts, `Unknown target entity "${connection.targetEntity}".`);
    }
    const result = await dispatch(companyId, undefined, { rows: [mapped], dryRun: false });
    const rowResult = result.rows[0];
    if (rowResult?.created) {
      await this.prisma.withTenant(companyId, (tx) => tx.integrationDeadLetter.update({ where: { id: deadLetter.id }, data: { status: 'RESOLVED', nextRetryAt: null } }));
      return 'RESOLVED';
    }
    return this.bumpDeadLetterAttempt(companyId, deadLetter.id, deadLetter.attempts, rowResult?.errors.join('; ') || 'Retry failed validation.');
  }

  private async bumpDeadLetterAttempt(companyId: string, id: string, previousAttempts: number, errorMessage: string): Promise<'FAILED' | 'DEAD'> {
    const attempts = previousAttempts + 1;
    const dead = attempts >= MAX_DEAD_LETTER_ATTEMPTS;
    await this.prisma.withTenant(companyId, (tx) =>
      tx.integrationDeadLetter.update({
        where: { id },
        data: dead
          ? { status: 'DEAD', attempts, errorMessage, nextRetryAt: null }
          : { status: 'PENDING_RETRY', attempts, errorMessage, nextRetryAt: this.backoffFrom(attempts) },
      }),
    );
    return dead ? 'DEAD' : 'FAILED';
  }
}
