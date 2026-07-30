import { IsOptional, IsUUID } from 'class-validator';

export class ReattemptStopDto {
  /**
   * An existing non-terminal job to add the redelivery stop to. Omit to have
   * a fresh job created automatically, carrying over the original job's
   * asset/operator if each is still active (same safety rule as duplicate()).
   */
  @IsOptional()
  @IsUUID()
  targetJobId?: string;
}
