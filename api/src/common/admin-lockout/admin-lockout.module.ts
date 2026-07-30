import { Module } from '@nestjs/common';
import { AdminLockoutGuardService } from './admin-lockout-guard.service';

@Module({
  providers: [AdminLockoutGuardService],
  exports: [AdminLockoutGuardService],
})
export class AdminLockoutModule {}
