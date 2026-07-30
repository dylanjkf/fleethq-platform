import { MaintenanceJobStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Covers title/description edits and the non-terminal status transitions
 * (Open / In Progress / Parts Pending). Moving to Complete is intentionally
 * not reachable here — see `POST /:id/close`, which also requires resolution
 * notes and stamps `completedAt`.
 */
export class UpdateMaintenanceJobDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(MaintenanceJobStatus, { message: 'status must be OPEN, IN_PROGRESS, or PARTS_PENDING here' })
  status?: MaintenanceJobStatus;
}
