import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class StopInputDto {
  /**
   * A saved Customer to attach to this stop. When provided, any of
   * label/address/contactName left unset are defaulted from the Customer record
   * — the caller can still override any of them per stop (e.g. a one-off
   * alternate site for the same customer).
   */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  /** The promised delivery window for this stop, if any (e.g. "9am-12pm"). */
  @IsOptional()
  @IsDateString()
  windowStart?: string;

  @IsOptional()
  @IsDateString()
  windowEnd?: string;
}

export class AddStopsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StopInputDto)
  stops!: StopInputDto[];
}
