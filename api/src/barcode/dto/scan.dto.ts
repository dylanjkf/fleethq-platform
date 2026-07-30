import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ScanDto {
  @IsUUID()
  jobId!: string;

  @IsUUID()
  stopId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  scannedValue!: string;
}

export class ScanFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;

  @IsOptional() @IsString() @MaxLength(100) trackingNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) consignmentNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) manifestNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) internalId?: string;
  @IsOptional() @IsString() @MaxLength(100) customerReference?: string;
  @IsOptional() @IsString() @MaxLength(500) deliveryAddress?: string;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @IsOptional() @IsString() @MaxLength(2000) deliveryNotes?: string;
  @IsOptional() @IsString() @MaxLength(100) serviceType?: string;

  @IsOptional() @IsInt() parcelCount?: number;
  @IsOptional() @IsNumber() weightKg?: number;
  @IsOptional() @IsNumber() cubicM3?: number;
  @IsOptional() @IsBoolean() dangerousGoods?: boolean;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class CreateFromScanDto {
  @IsUUID()
  jobId!: string;

  @IsUUID()
  stopId!: string;

  @ValidateNested()
  @Type(() => ScanFieldsDto)
  fields!: ScanFieldsDto;
}
