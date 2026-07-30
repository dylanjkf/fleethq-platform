import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BarcodeFieldTarget, BarcodeScanMode } from '@prisma/client';
import { MAX_PAGE_SIZE } from '../../common/dto/list-query.dto';

const FIELD_TARGET_VALUES = Object.values(BarcodeFieldTarget);

export class UpdateBarcodeScanConfigDto {
  @IsOptional()
  @IsEnum(BarcodeScanMode)
  scanMode?: BarcodeScanMode;

  @IsOptional()
  @IsBoolean()
  allowManualEntry?: boolean;

  @IsOptional()
  @IsBoolean()
  blockOnMissingFields?: boolean;

  /** BarcodeFieldTarget values (as strings) that must resolve before a scan can proceed. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FIELD_TARGET_VALUES.length)
  @IsIn(FIELD_TARGET_VALUES, { each: true })
  requiredFields?: string[];
}

export class ScanHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 50;
}
