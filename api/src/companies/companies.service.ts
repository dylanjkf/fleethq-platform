import { randomUUID } from 'crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AuthService, LoginResult } from '../auth/auth.service';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { provisionCompany } from './provision-company';
import { TRIAL_DAYS } from '../billing/plans';
import { SignupCompanyDto } from './dto/signup-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly authService: AuthService,
    private readonly authTokens: AuthTokensService,
    private readonly authMail: AuthMailService,
  ) {}

  async signup(dto: SignupCompanyDto): Promise<LoginResult> {
    const companyId = randomUUID();

    try {
      const result = await this.prisma.withTenant(companyId, (tx) =>
        provisionCompany(tx, {
          companyId,
          companyName: dto.companyName,
          adminUsername: dto.adminUsername,
          adminPassword: dto.adminPassword,
          adminFullName: dto.adminFullName,
          adminEmail: dto.adminEmail,
          trialDays: TRIAL_DAYS,
        }),
      );

      // Send a verification email if they gave one. Best-effort — a signup must
      // still succeed (and log the new admin straight in) even if email is
      // unconfigured or the send fails.
      if (dto.adminEmail) {
        try {
          const token = await this.authTokens.issue(result.adminUserId, 'EMAIL_VERIFY');
          await this.authMail.sendVerification(dto.adminEmail, dto.adminFullName, token);
        } catch {
          // swallow — verification can be re-requested from the app
        }
      }

      return {
        status: 'authenticated',
        accessToken: this.authService.issueSessionToken(
          result.adminUserId,
          result.companyId,
          result.adminMembershipId,
          // Brand-new user — tokenVersion starts at 0.
          0,
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
      for (const field of ['name', 'supportPhone', 'supportNotes'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const company = await tx.company.update({
        where: { id: companyId },
        data: { name: dto.name, supportPhone: dto.supportPhone, supportNotes: dto.supportNotes },
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
