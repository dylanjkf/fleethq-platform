import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class CreateStockItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  /** Free-form customer-defined fields (batch, supplier, expiry, …). */
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class UpdateStockItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class AdjustStockDto {
  /** Signed delta applied to on-hand quantity (e.g. -5 picked, +50 received). */
  @IsNumber()
  delta!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ListStockDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  // `search` is inherited from ListQueryDto.

  /** Only items at or below their min-quantity threshold. */
  @IsOptional()
  @IsString()
  lowStock?: string;
}

/** One row of a bulk stock import — same fields as create, all optional-safe. */
export class ImportStockRowsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateStockItemDto)
  rows!: CreateStockItemDto[];
}
