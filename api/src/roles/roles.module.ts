import { Module } from '@nestjs/common';
import { AdminLockoutModule } from '../common/admin-lockout/admin-lockout.module';
import { TimelineModule } from '../timeline/timeline.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [TimelineModule, AdminLockoutModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
