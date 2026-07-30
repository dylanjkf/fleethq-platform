import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Infra endpoints, not the business API contract — deliberately version-
 * neutral (sits at /health, not /v1/health) since a load balancer or
 * orchestrator config shouldn't have to track API versioning.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Liveness — "is the process up at all." No dependency checks on purpose:
   * a transient DB blip shouldn't make an orchestrator kill and restart an
   * otherwise-healthy instance (that's what readiness is for).
   */
  @Public()
  @Get()
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /**
   * Readiness — "can this instance actually serve requests right now."
   * What a load balancer should check before routing traffic to it.
   */
  @Public()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.prismaHealth.pingCheck('database', this.prisma)]);
  }
}
