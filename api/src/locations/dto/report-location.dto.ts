import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * A single live-location fix reported by a DriverOS device. Latitude/longitude
 * are validated to real WGS84 ranges so a garbage fix (e.g. 0,0 from a failed
 * GPS read, or an out-of-range value) is rejected at the edge rather than
 * plotted on the dispatch board.
 */
export class ReportLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  /** GPS accuracy radius in metres, if the device reported one. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyM?: number;
}
