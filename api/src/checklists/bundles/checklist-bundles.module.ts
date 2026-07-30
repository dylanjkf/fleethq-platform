import { Module } from '@nestjs/common';
import { ChecklistBundlesController } from './checklist-bundles.controller';
import { ChecklistBundlesService } from './checklist-bundles.service';

@Module({
  controllers: [ChecklistBundlesController],
  providers: [ChecklistBundlesService],
})
export class ChecklistBundlesModule {}
