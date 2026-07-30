import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class RegisterGpsDeviceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Free-text provider/model label, e.g. "Teltonika FMB920". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  /** Optionally bind to an asset at registration. */
  @IsOptional()
  @IsUUID()
  assetId?: string;
}

export class UpdateGpsDeviceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  /** Bind (uuid) or unbind (null) the asset. */
  @IsOptional()
  assetId?: string | null;
}

/**
 * The universal ingest payload. Any tracker or telematics provider POSTs this
 * with its `deviceKey`; lat/lng are WGS84. `recordedAt` is optional (defaults to
 * now) so a device can report a buffered fix with its real timestamp.
 */
export class IngestGpsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  deviceKey!: string;

  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsNumber()
  speedKph?: number;

  @IsOptional()
  @IsNumber()
  headingDeg?: number;

  @IsOptional()
  @IsString()
  recordedAt?: string;
}
