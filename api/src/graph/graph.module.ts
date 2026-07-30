import { Module } from '@nestjs/common';
import { GraphController } from './graph.controller';
import { GraphQueryService } from './graph-query.service';

@Module({
  controllers: [GraphController],
  providers: [GraphQueryService],
})
export class GraphModule {}
