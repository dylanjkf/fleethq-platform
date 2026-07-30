import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class CreateFuelEntryDto {
  /** Client-generated idempotency key: an offline entry replayed after a lost
   *  response is deduplicated server-side, so it can't inflate the spend total. */
  @IsOptional()
  @IsUUID()
  clientRequestId?: string;

  /** Odometer at the pump — the number that makes fuel economy computable. */
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  odometerReading!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(16)
  licencePlate!: string;

  /**
   * The last four digits of the fuel card, and nothing more. Rejecting anything
   * that isn't exactly four digits is the point: it stops a full card number
   * being submitted at the edge, before the database CHECK has to.
   */
  @Matches(/^[0-9]{4}$/, { message: 'cardLast4 must be exactly the last 4 digits of the card.' })
  cardLast4!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  @Type(() => Number)
  litres?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  @Type(() => Number)
  totalCost?: number;

  /** Which asset this was for, when the office wants the plate resolved. */
  @IsOptional()
  @IsUUID()
  assetId?: string;

  /** When the tank was filled. Defaults to now; set it when syncing an offline entry. */
  @IsOptional()
  @IsISO8601()
  filledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // Receipt photo, stored via AttachmentsService like POD photos.
  @IsOptional()
  @IsString()
  receiptBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  receiptFilename?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  receiptContentType?: string;
}

export class ListFuelEntriesDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
