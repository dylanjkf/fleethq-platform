import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationAuthType, IntegrationCredential, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { IntegrationCryptoService } from './integration-crypto.service';

export interface CreateCredentialInput {
  name: string;
  authType: IntegrationAuthType;
  secretValue?: string;
}

export interface UpdateCredentialInput {
  name?: string;
  secretValue?: string;
}

/** Never let a secret leave this service — encryptedPayload/iv/tag are stripped from every response. */
type SafeCredential = Omit<IntegrationCredential, 'encryptedPayload' | 'encryptionIv' | 'encryptionTag'>;

function stripSecret(row: IntegrationCredential): SafeCredential {
  const { encryptedPayload: _encryptedPayload, encryptionIv: _encryptionIv, encryptionTag: _encryptionTag, ...safe } = row;
  return safe;
}

/**
 * The credential vault (10-Integrations/Integration_Hub.md). Every stored
 * secret is encrypted at rest via IntegrationCryptoService (AES-256-GCM); the
 * whole point of the vault is that listing/editing a connection never
 * round-trips a secret, so no method here ever returns encryptedPayload/
 * encryptionIv/encryptionTag.
 */
@Injectable()
export class IntegrationCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: IntegrationCryptoService,
    private readonly audit: AuditService,
  ) {}

  async create(companyId: string, actorUserId: string | undefined, input: CreateCredentialInput): Promise<SafeCredential> {
    if (input.authType !== 'NONE' && !input.secretValue?.trim()) {
      throw new BadRequestException({ code: 'INTEGRATION_CREDENTIAL_SECRET_REQUIRED', message: 'A secret value is required unless authType is NONE.' });
    }
    const enc = this.crypto.encrypt(input.secretValue ?? '');
    const row = await this.prisma.withTenant(companyId, async (tx) => {
      const created = await tx.integrationCredential.create({
        data: {
          companyId,
          name: input.name,
          authType: input.authType,
          encryptedPayload: enc.encryptedPayload,
          encryptionIv: enc.iv,
          encryptionTag: enc.tag,
        },
      });
      return stripSecret(created);
    });
    await this.audit.record(companyId, {
      action: AUDIT_ACTIONS.INTEGRATION_CREDENTIAL_CREATED,
      actorUserId: actorUserId ?? null,
      targetType: 'IntegrationCredential',
      targetId: row.id,
      outcome: 'success',
      metadata: { authType: row.authType, name: row.name },
    });
    return row;
  }

  async list(companyId: string, includeArchived: boolean): Promise<{ items: SafeCredential[] }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const rows = await tx.integrationCredential.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return { items: rows.map(stripSecret) };
    });
  }

  async update(companyId: string, id: string, input: UpdateCredentialInput): Promise<SafeCredential> {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireRow(tx, companyId, id);
      const data: Prisma.IntegrationCredentialUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.secretValue !== undefined) {
        const enc = this.crypto.encrypt(input.secretValue);
        data.encryptedPayload = enc.encryptedPayload;
        data.encryptionIv = enc.iv;
        data.encryptionTag = enc.tag;
        data.rotatedAt = new Date();
      }
      const row = await tx.integrationCredential.update({ where: { id }, data });
      return stripSecret(row);
    });
  }

  async archive(companyId: string, id: string): Promise<SafeCredential> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireRow(tx, companyId, id);
      if (existing.archivedAt) return stripSecret(existing);
      const row = await tx.integrationCredential.update({ where: { id }, data: { archivedAt: new Date() } });
      return stripSecret(row);
    });
  }

  /**
   * The whole "test" for now: prove the stored ciphertext still decrypts with
   * the current key. Actually calling the external system to validate the
   * credential is out of scope for this narrowed milestone (no bespoke
   * per-vendor client exists to call) — documented simplification.
   */
  async test(companyId: string, id: string): Promise<{ ok: boolean; message: string }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const row = await this.requireRow(tx, companyId, id);
      try {
        this.crypto.decrypt({ encryptedPayload: row.encryptedPayload, iv: row.encryptionIv, tag: row.encryptionTag });
        return { ok: true, message: 'Credential decrypts successfully with the current vault key.' };
      } catch {
        return { ok: false, message: 'Credential could not be decrypted — it may predate a key rotation, or its stored payload is corrupted.' };
      }
    });
  }

  /** The one place the plaintext secret is read — Sync Engine / Webhook Service only, never a controller response. */
  async getDecryptedSecret(companyId: string, credentialId: string): Promise<{ authType: IntegrationAuthType; secretValue: string }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const row = await this.requireRow(tx, companyId, credentialId);
      return {
        authType: row.authType,
        secretValue: this.crypto.decrypt({ encryptedPayload: row.encryptedPayload, iv: row.encryptionIv, tag: row.encryptionTag }),
      };
    });
  }

  private async requireRow(tx: Prisma.TransactionClient, companyId: string, id: string): Promise<IntegrationCredential> {
    const row = await tx.integrationCredential.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'INTEGRATION_CREDENTIAL_NOT_FOUND', message: 'Credential not found.' });
    }
    return row;
  }
}
