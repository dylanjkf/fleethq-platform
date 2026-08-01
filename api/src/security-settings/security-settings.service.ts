import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { UpdateSecuritySettingsDto } from './dto/security-settings.dto';

/** Platform defaults when a company hasn't set its own security policy. */
export const DEFAULT_SECURITY_SETTINGS = { mfaRequired: false, passwordExpiryDays: null as number | null };

/**
 * Per-company MFA/password policy (Auth/Billing Platform Phase 3,
 * 22-Auth-Billing-Platform/Overview.md) — mirrors AnalyticsService's own
 * upsert-a-singleton-row pattern. The row this manages is also read directly
 * by AuthService during login (via PrismaService.withUser, before any tenant
 * context is chosen) to decide whether a login needs to be redirected into
 * forced MFA enrolment or a forced password change — see
 * CompanySecuritySettings's schema doc comment for why its RLS policy is
 * shaped differently from every other per-company settings table.
 */
@Injectable()
export class SecuritySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getSettings(companyId: string) {
    const row = await this.prisma.withTenant(companyId, (tx) => tx.companySecuritySettings.findUnique({ where: { companyId } }));
    return {
      mfaRequired: row?.mfaRequired ?? DEFAULT_SECURITY_SETTINGS.mfaRequired,
      passwordExpiryDays: row?.passwordExpiryDays ?? DEFAULT_SECURITY_SETTINGS.passwordExpiryDays,
      isDefault: !row,
    };
  }

  async updateSettings(companyId: string, actorUserId: string, dto: UpdateSecuritySettingsDto) {
    const result = await this.prisma.withTenant(companyId, (tx) =>
      tx.companySecuritySettings.upsert({
        where: { companyId },
        create: {
          companyId,
          mfaRequired: dto.mfaRequired ?? DEFAULT_SECURITY_SETTINGS.mfaRequired,
          passwordExpiryDays: dto.passwordExpiryDays === undefined ? DEFAULT_SECURITY_SETTINGS.passwordExpiryDays : dto.passwordExpiryDays,
        },
        update: {
          ...(dto.mfaRequired !== undefined && { mfaRequired: dto.mfaRequired }),
          ...(dto.passwordExpiryDays !== undefined && { passwordExpiryDays: dto.passwordExpiryDays }),
        },
      }),
    );
    await this.audit.record(companyId, {
      actorUserId,
      action: AUDIT_ACTIONS.SECURITY_SETTINGS_UPDATED,
      targetType: 'company_security_settings',
      metadata: { mfaRequired: result.mfaRequired, passwordExpiryDays: result.passwordExpiryDays },
    });
    return { mfaRequired: result.mfaRequired, passwordExpiryDays: result.passwordExpiryDays, isDefault: false };
  }
}
