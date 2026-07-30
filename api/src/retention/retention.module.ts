import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

/**
 * Data-retention enforcement (see RetentionService). Exported so the background
 * SchedulerService can drive the periodic purge; PrismaModule is global, so the
 * Prisma clients resolve without an explicit import here.
 */
@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
