import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class ParcelInputDto {
  /** The barcode / consignment number for this parcel. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

export class AddParcelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ParcelInputDto)
  parcels!: ParcelInputDto[];
}

export class ScanParcelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;
}
