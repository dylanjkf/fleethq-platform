import { Controller, Get } from '@nestjs/common';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { AnnouncementsService } from './announcements.service';

@Controller({ path: 'announcements', version: '1' })
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** Every authenticated user of any role/company sees the same list — no business permission gates this. */
  @AuthenticatedOnly()
  @Get('active')
  listActive() {
    return this.announcements.listActive();
  }
}
