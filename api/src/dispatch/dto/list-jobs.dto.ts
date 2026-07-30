import { JobStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export const JOB_VIEWS = ['today', 'upcoming', 'history'] as const;
export type JobView = (typeof JOB_VIEWS)[number];

/**
 * `operatorId` is DriverOS's "Today" screen filter (04-DriverOS/DriverOS_Overview.md):
 * an operator only wants jobs assigned to them, not the whole company's list.
 *
 * `view` is FleetHQ's Dispatch date filter — a 3-way partition every job
 * falls into exactly one of: `history` (a terminal job, any date), `upcoming`
 * (still active, scheduled after today), `today` (still active and either
 * unscheduled or due today-or-earlier, so nothing active is ever hidden).
 */
export class ListJobsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  @IsIn(JOB_VIEWS)
  view?: JobView;
}
