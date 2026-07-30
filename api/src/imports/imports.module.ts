import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { OperatorsModule } from '../operators/operators.module';
import { DepotsModule } from '../depots/depots.module';
import { CustomersModule } from '../customers/customers.module';
import { AttachedUnitsModule } from '../attached-units/attached-units.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [AssetsModule, OperatorsModule, DepotsModule, CustomersModule, AttachedUnitsModule, ComplianceModule],
  controllers: [ImportsController],
  providers: [ImportsService],
  // Exported so the Integration Hub's Sync Engine can reuse the exact same
  // per-entity create paths for every sync, instead of reimplementing them.
  exports: [ImportsService],
})
export class ImportsModule {}
