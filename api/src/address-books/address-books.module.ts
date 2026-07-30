import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AddressBooksController } from './address-books.controller';
import { AddressBooksService } from './address-books.service';

@Module({
  imports: [TimelineModule],
  controllers: [AddressBooksController],
  providers: [AddressBooksService],
})
export class AddressBooksModule {}
