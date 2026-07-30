import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SystemPrismaService } from './system-prisma.service';
import { AdminPrismaService } from './admin-prisma.service';

@Global()
@Module({
  providers: [PrismaService, SystemPrismaService, AdminPrismaService],
  exports: [PrismaService, SystemPrismaService, AdminPrismaService],
})
export class PrismaModule {}
