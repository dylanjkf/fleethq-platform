import { randomUUID } from 'crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import type { LoginResult } from '../auth/auth.service';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { BreachedPasswordService } from '../auth/breached-password.service';
import { provisionCompany } from './provision-company';
import { SignupCompanyDto } from './dto/signup-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly sessions: AuthSessionsService,
    private readonly authTokens: AuthTokensService,
    private readonly authMail: AuthMailService,
    private readonly breachedPassword: BreachedPasswordService,
  ) {}

  async signup(dto: SignupCompanyDto, context: { ip?: string | null; userAgent?: string | null } = {}): Promise<LoginResult> {
    const companyId = randomUUID();

    // Reject a chosen password that appears in a known breach corpus before we
    // provision anything (fail-open if HIBP is unreachable — see the service).
    await this.breachedPassword.assertNotBreached(dto.adminPassword);

    try {
      const result = await this.prisma.withTenant(companyId, (tx) =>
        provisionCompany(tx, {
          companyId,
          companyName: dto.companyName,
          adminUsername: dto.adminUsername,
          adminPassword: dto.adminPassword,
          adminFullName: dto.adminFullName,
          adminEmail: dto.adminEmail,
          // No free trial — FleetHQ has no self-service signup path in the
          // product anymore (see fleethq-frontend's LoginPage/ContactPage);
          // this endpoint still exists for direct/internal provisioning.
          abn: dto.abn,
          industry: dto.industry,
          phone: dto.phone,
          fleetSizeEstimate: dto.fleetSizeEstimate,
          // dto.acceptedTerms is validated `=== true` by SignupCompanyDto — the timestamp is what's actually meaningful to record.
          termsAcceptedAt: new Date(),
        }),
      );

      // Send a verification email if they gave one. Best-effort — a signup must
      // still succeed (and log the new admin straight in) even if email is
      // unconfigured or the send fails.
      if (dto.adminEmail) {
        try {
          const token = await this.authTokens.issue(result.adminUserId, 'EMAIL_VERIFY');
          await this.authMail.sendVerification(dto.adminEmail, dto.adminFullName, token);
        } catch (err) {
          // Best-effort — verification can be re-requested from the app. Logged
          // so a new signup whose verification email silently never sent is
          // diagnosable (otherwise the admin looks "stuck unverified" for no
          // visible reason).
          this.logger.warn(
            `Verification email for new company admin ${result.adminUserId} failed to send: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        status: 'authenticated',
        accessToken: await this.sessions.issueSessionToken(
          result.adminUserId,
          result.companyId,
          result.adminMembershipId,
          // Brand-new user — tokenVersion starts at 0.
          0,
          { ip: context.ip, userAgent: context.userAgent },
        ),
        company: { id: result.companyId, name: result.companyName },
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: 'That username is already in use.',
        });
      }
      throw err;
    }
  }

  async getMe(companyId: string) {
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUnique({ where: { id: companyId } }),
    );
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found.' });
    }
    return company;
  }

  async updateMe(companyId: string, actorUserId: string, dto: UpdateCompanyDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.company.findUnique({ where: { id: companyId } });
      if (!existing) {
        throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found.' });
      }

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'supportPhone', 'supportNotes', 'abn', 'industry', 'phone', 'fleetSizeEstimate'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const company = await tx.company.update({
        where: { id: companyId },
        data: {
          name: dto.name,
          supportPhone: dto.supportPhone,
          supportNotes: dto.supportNotes,
          abn: dto.abn,
          industry: dto.industry,
          phone: dto.phone,
          fleetSizeEstimate: dto.fleetSizeEstimate,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.COMPANY,
          entityId: companyId,
          eventType: 'updated',
          summary: `Company "${company.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return company;
    });
  }

  /**
   * 01-Product/Support_Help_Pathway.md: readable by anyone authenticated in
   * the company, no companies:view gate — a driver stuck mid-shift needs
   * this regardless of whether their role grants company-settings access.
   */
  async getSupportInfo(companyId: string) {
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUnique({ where: { id: companyId }, select: { supportPhone: true, supportNotes: true } }),
    );
    if (!company) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found.' });
    }
    return company;
  }
}
