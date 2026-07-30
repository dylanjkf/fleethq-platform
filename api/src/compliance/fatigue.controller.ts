import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { FatigueService } from './fatigue.service';

@Controller({ path: 'fatigue', version: '1' })
export class FatigueController {
  constructor(
    private readonly fatigueService: FatigueService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * No @RequirePermission — every operator can see their own fatigue status
   * regardless of their role's permissions, the same "reads their own
   * context" precedent as notification preferences and company support
   * info. This is what DriverOS's Today page shows.
   */
  @Get('me')
  @AuthenticatedOnly()
  async getMyStatus(@CurrentUser() user: AuthenticatedRequestUser) {
    const operator = await this.prisma.withTenant(user.companyId, (tx) =>
      tx.operator.findFirst({ where: { userId: user.userId, archivedAt: null } }),
    );
    if (!operator) {
      throw new NotFoundException({ code: 'FATIGUE_OPERATOR_REQUIRED', message: "This login isn't linked to an Operator." });
    }
    return this.fatigueService.getStatusForOperator(user.companyId, operator.id);
  }

  @Get('at-risk')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  getAtRisk(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.fatigueService.getAtRiskOperators(user.companyId);
  }

  @Get('operators/:operatorId')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  getOperatorStatus(@CurrentUser() user: AuthenticatedRequestUser, @Param('operatorId', ParseUUIDPipe) operatorId: string) {
    return this.fatigueService.getStatusForOperator(user.companyId, operatorId);
  }
}
