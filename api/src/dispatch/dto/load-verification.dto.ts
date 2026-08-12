import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A driver's load-verification request for a run (item 2). Sent before starting,
 * once they've confirmed what's physically on the vehicle against the run's
 * expected manifest (its stops' StopParcel rows). Scanning / manual "mark
 * loaded" happen through the existing per-stop scan path — this request only
 * declares the driver's intent to proceed and, when there's a discrepancy,
 * whether they're explicitly overriding it.
 */
export class LoadVerificationDto {
  /**
   * The driver is confirming the load. Optional/defaulted true — the POST itself
   * is the confirmation; the flag is here so an explicit `false` can't sneak a
   * run past verification.
   */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  /**
   * Set only when the driver has SEEN a discrepancy (manifest items not
   * scanned/confirmed) and chooses to proceed anyway. Without it, a request that
   * still has unscanned parcels is rejected with LOAD_DISCREPANCY so a partial
   * load can never start unacknowledged.
   */
  @IsOptional()
  @IsBoolean()
  override?: boolean;

  /**
   * The references the driver acknowledges as missing when overriding. Advisory
   * only — the server recomputes the authoritative missing set from the DB and
   * records THAT in the override audit — but captured so the client's view is
   * part of the request.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  missingReferences?: string[];
}
