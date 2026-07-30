import { IsInt, IsNumber, IsOptional, IsString, Min, MaxLength, MinLength } from 'class-validator';

export class UpdatePartDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  partNumber?: string;

  /** A direct stock correction (e.g. after a restock or a stocktake), not a usage log line. */
  @IsOptional()
  @IsInt()
  @Min(0)
  quantityOnHand?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;
}
