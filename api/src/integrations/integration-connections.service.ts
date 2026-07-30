import { Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationConnection, IntegrationSyncStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { computeNextCronRun } from './integration-cron.util';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { CreateFieldMappingDto, UpdateFieldMappingDto } from './dto/field-mapping.dto';

/**
 * CRUD for IntegrationConnection + its nested field mappings, and the Sync
 * Dashboard summary. Never touches secrets directly — `credentialId` is just
 * a pointer, validated to belong to the same company, never dereferenced here.
 */
@Injectable()
export class IntegrationConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(companyId: string, actorUserId: string | undefined, input: CreateConnectionDto) {
    const created = await this.prisma.withTenant(companyId, async (tx) => {
      if (input.credentialId) await this.requireCredential(tx, companyId, input.credentialId);
      const nextRunAt = input.scheduleCron ? computeNextCronRun(input.scheduleCron, new Date()) : null;
      return tx.integrationConnection.create({
        data: {
          companyId,
          name: input.name,
          connectorType: input.connectorType,
          direction: input.direction,
          targetEntity: input.targetEntity,
          config: input.config as Prisma.InputJsonValue,
          credentialId: input.credentialId,
          scheduleCron: input.scheduleCron,
          isEnabled: input.isEnabled ?? true,
          nextRunAt,
        },
      });
    });
    await this.audit.record(companyId, {
      action: AUDIT_ACTIONS.INTEGRATION_CONNECTION_CREATED,
      actorUserId: actorUserId ?? null,
      targetType: 'IntegrationConnection',
      targetId: created.id,
      outcome: 'success',
      metadata: { name: created.name, connectorType: created.connectorType, targetEntity: created.targetEntity },
    });
    return created;
  }

  async list(companyId: string, includeArchived: boolean) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.integrationConnection.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return { items };
    });
  }

  async get(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const connection = await this.requireConnectionTx(tx, companyId, id);
      const fieldMappings = await tx.integrationFieldMapping.findMany({
        where: { connectionId: id, archivedAt: null },
        orderBy: { order: 'asc' },
      });
      return { ...connection, fieldMappings };
    });
  }

  async update(companyId: string, id: string, input: UpdateConnectionDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireConnectionTx(tx, companyId, id);
      if (input.credentialId) await this.requireCredential(tx, companyId, input.credentialId);

      const scheduleCron = input.scheduleCron === undefined ? existing.scheduleCron : input.scheduleCron;
      // Recompute nextRunAt whenever the cron expression actually changes —
      // an unchanged schedule keeps its existing nextRunAt so an in-flight
      // wait isn't reset by an unrelated edit (e.g. renaming the connection).
      const nextRunAt =
        input.scheduleCron !== undefined && input.scheduleCron !== existing.scheduleCron
          ? scheduleCron
            ? computeNextCronRun(scheduleCron, new Date())
            : null
          : undefined;

      return tx.integrationConnection.update({
        where: { id },
        data: {
          name: input.name,
          connectorType: input.connectorType,
          direction: input.direction,
          targetEntity: input.targetEntity,
          config: input.config === undefined ? undefined : (input.config as Prisma.InputJsonValue),
          credentialId: input.credentialId === undefined ? undefined : input.credentialId,
          scheduleCron: input.scheduleCron === undefined ? undefined : input.scheduleCron,
          nextRunAt,
          isEnabled: input.isEnabled,
        },
      });
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireConnectionTx(tx, companyId, id);
      if (existing.archivedAt) return existing;
      return tx.integrationConnection.update({ where: { id }, data: { archivedAt: new Date(), isEnabled: false } });
    });
  }

  // ---- Field mappings ----------------------------------------------------

  async listFieldMappings(companyId: string, connectionId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireConnectionTx(tx, companyId, connectionId);
      const items = await tx.integrationFieldMapping.findMany({
        where: { connectionId, archivedAt: null },
        orderBy: { order: 'asc' },
      });
      return { items };
    });
  }

  async createFieldMapping(companyId: string, connectionId: string, input: CreateFieldMappingDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireConnectionTx(tx, companyId, connectionId);
      return tx.integrationFieldMapping.create({
        data: {
          companyId,
          connectionId,
          externalField: input.externalField,
          fleetField: input.fleetField,
          transform: input.transform ?? 'NONE',
          transformConfig: input.transformConfig as Prisma.InputJsonValue | undefined,
          isRequired: input.isRequired ?? false,
          order: input.order ?? 0,
        },
      });
    });
  }

  async updateFieldMapping(companyId: string, id: string, input: UpdateFieldMappingDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireFieldMapping(tx, companyId, id);
      return tx.integrationFieldMapping.update({
        where: { id },
        data: {
          externalField: input.externalField,
          fleetField: input.fleetField,
          transform: input.transform,
          transformConfig: input.transformConfig === undefined ? undefined : (input.transformConfig as Prisma.InputJsonValue),
          isRequired: input.isRequired,
          order: input.order,
        },
      });
    });
  }

  async archiveFieldMapping(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireFieldMapping(tx, companyId, id);
      if (existing.archivedAt) return existing;
      return tx.integrationFieldMapping.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  // ---- Sync history / dead letters (read-only; writes happen via IntegrationSyncEngine) ----

  async listSyncRuns(companyId: string, connectionId: string, skip: number, take: number) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.integrationSyncRun.findMany({ where: { connectionId }, orderBy: { startedAt: 'desc' }, skip, take }),
        tx.integrationSyncRun.count({ where: { connectionId } }),
      ]);
      return { items, total };
    });
  }

  async listDeadLetters(companyId: string, connectionId: string, skip: number, take: number) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.integrationDeadLetter.findMany({ where: { connectionId }, orderBy: { createdAt: 'desc' }, skip, take }),
        tx.integrationDeadLetter.count({ where: { connectionId } }),
      ]);
      return { items, total };
    });
  }

  // ---- Sync dashboard ------------------------------------------------------

  /** Powers the Sync Dashboard: connection health counts, pending dead letters, recent runs. */
  async dashboard(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const connections = await tx.integrationConnection.findMany({ where: { archivedAt: null } });
      const connectionsByHealth: Record<string, number> = {
        SUCCESS: 0,
        PARTIAL_FAILURE: 0,
        FAILURE: 0,
        PENDING: 0,
        RUNNING: 0,
        NEVER_RUN: 0,
      };
      for (const connection of connections) {
        const key: IntegrationSyncStatus | 'NEVER_RUN' = connection.lastSyncStatus ?? 'NEVER_RUN';
        connectionsByHealth[key] = (connectionsByHealth[key] ?? 0) + 1;
      }
      const [pendingDeadLetters, deadDeadLetters, recentRuns] = await Promise.all([
        tx.integrationDeadLetter.count({ where: { status: { in: ['PENDING_RETRY', 'RETRYING'] } } }),
        tx.integrationDeadLetter.count({ where: { status: 'DEAD' } }),
        tx.integrationSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      ]);
      return {
        totalConnections: connections.length,
        connectionsByHealth,
        pendingDeadLetters,
        deadDeadLetters,
        recentRuns,
      };
    });
  }

  // ---- helpers --------------------------------------------------------------

  /** Public — reused by IntegrationSyncEngine/IntegrationWebhookService to check ownership without duplicating the query. */
  async requireConnection(companyId: string, id: string): Promise<IntegrationConnection> {
    return this.prisma.withTenant(companyId, (tx) => this.requireConnectionTx(tx, companyId, id));
  }

  private async requireConnectionTx(tx: Prisma.TransactionClient, companyId: string, id: string): Promise<IntegrationConnection> {
    const row = await tx.integrationConnection.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_CONNECTION_NOT_FOUND', message: 'Integration connection not found.' });
    }
    return row;
  }

  private async requireFieldMapping(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const row = await tx.integrationFieldMapping.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_FIELD_MAPPING_NOT_FOUND', message: 'Field mapping not found.' });
    }
    return row;
  }

  private async requireCredential(tx: Prisma.TransactionClient, companyId: string, credentialId: string) {
    const row = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
    if (!row || row.companyId !== companyId || row.archivedAt) {
      throw new NotFoundException({ code: 'INTEGRATION_CREDENTIAL_NOT_FOUND', message: 'Credential not found.' });
    }
  }
}
