import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class ListAuditLogsDto extends ListQueryDto {
  /** Filter to a single action (e.g. `auth.login_failed`). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  /** Filter to successes or failures. */
  @IsOptional()
  @IsIn(['success', 'failure'])
  outcome?: 'success' | 'failure';

  /** Only events performed by this user — "what did this account do?". */
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  /** Only events about this kind of target (e.g. `user`, `role`, `operator`). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  targetType?: string;

  /** Only events at/after this instant (inclusive) — the incident window start. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Only events at/before this instant (inclusive) — the incident window end. */
  @IsOptional()
  @IsISO8601()
  to?: string;
}
