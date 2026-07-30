import { ArrayMaxSize, IsArray, IsOptional } from 'class-validator';

/**
 * Manual sync trigger body. `rows` is required for a CSV connector (parsed
 * client-side, exactly like the bulk `imports` module — no file bytes ever hit
 * the API) and ignored for a REST connector (the Sync Engine fetches its own
 * rows from `connection.config.url`). Not `@ValidateNested` against the target
 * entity here for the same reason ImportRowsDto isn't — per-row validation
 * happens inside the Sync Engine so one bad row never rejects the whole batch.
 */
export class SyncConnectionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  rows?: Record<string, unknown>[];
}
