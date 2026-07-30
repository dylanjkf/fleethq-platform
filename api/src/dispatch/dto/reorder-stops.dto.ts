import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/**
 * The job's PENDING stops, in the desired new order. Must be exactly the set
 * of currently-pending stop ids on the job (each once) — completed/failed
 * stops keep their historical position and are never reordered. No
 * `@ArrayMinSize` since a job with zero pending stops legitimately reorders an
 * empty list (a no-op).
 */
export class ReorderStopsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  stopIds!: string[];
}
