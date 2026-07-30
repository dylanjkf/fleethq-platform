import { Module } from '@nestjs/common';
import { AssetClassesController } from './asset-classes.controller';
import { AssetClassesService } from './asset-classes.service';

@Module({
  controllers: [AssetClassesController],
  providers: [AssetClassesService],
})
export class AssetClassesModule {}
