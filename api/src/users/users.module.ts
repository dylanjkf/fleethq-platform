import { Module } from '@nestjs/common';
import { AdminLockoutModule } from '../common/admin-lockout/admin-lockout.module';
import { TimelineModule } from '../timeline/timeline.module';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TimelineModule, AdminLockoutModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
