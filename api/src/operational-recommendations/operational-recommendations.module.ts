import { Module } from '@nestjs/common';
import { OperationalRecommendationsController } from './operational-recommendations.controller';
import { OperationalRecommendationsService } from './operational-recommendations.service';

@Module({
  controllers: [OperationalRecommendationsController],
  providers: [OperationalRecommendationsService],
  exports: [OperationalRecommendationsService],
})
export class OperationalRecommendationsModule {}
