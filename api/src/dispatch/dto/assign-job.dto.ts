import { IsBoolean, IsDateString, IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * Both fields are independently optional and nullable: omit a field to leave
 * it unchanged, send a UUID to set it, or send `null` to explicitly unassign
 * just that side (e.g. keep the asset but remove the operator). At least one
 * of the two must actually be present in the request body — enforced in the
 * service, not here, since "at least one of two optional fields" isn't a
 * single-field class-validator constraint.
 */
export class AssignJobDto {
  @ValidateIf((o) => o.assetId !== null)
  @IsOptional()
  @IsUUID()
  assetId?: string | null;

  @ValidateIf((o) => o.operatorId !== null)
  @IsOptional()
  @IsUUID()
  operatorId?: string | null;

  /** The fleet's own pickup location for this run, if any (see Depot). */
  @ValidateIf((o) => o.pickupDepotId !== null)
  @IsOptional()
  @IsUUID()
  pickupDepotId?: string | null;

  /**
   * Confirms the dispatcher has seen and is knowingly proceeding past a
   * flagged fatigue risk on the assigned operator (08-Compliance/
   * Australian_Compliance.md's override edge case). Omitting this when a
   * risk is actually flagged makes `assign` fail with `FATIGUE_RISK_UNACKNOWLEDGED`
   * rather than silently proceeding.
   */
  @IsOptional()
  @IsBoolean()
  acknowledgeFatigueRisk?: boolean;

  /**
   * Optimistic-concurrency token: the `updatedAt` the dispatcher's client last
   * saw for this job. When provided, the assign is rejected with `JOB_MODIFIED`
   * if the job has changed since (another dispatcher reassigned it, or a driver
   * completed a stop) — so a stale dispatch board can't silently clobber a
   * newer assignment. Omitting it keeps the previous last-write-wins behaviour.
   */
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}
