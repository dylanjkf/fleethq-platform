import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SystemPrismaService } from './system-prisma.service';

@Global()
@Module({
  providers: [PrismaService, SystemPrismaService],
  exports: [PrismaService, SystemPrismaService],
})
export class PrismaModule {}
