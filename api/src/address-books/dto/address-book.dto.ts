import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

/** One saved location inside an address book — a depot (our pickup site) or a customer (delivery destination). */
export class AddressBookEntryDto {
  @IsIn(['depot', 'customer'])
  kind!: 'depot' | 'customer';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  /** Customers only — depots have no contact person. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  /** Customers only. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * Save the current company's depots and/or customers into a named, reusable
 * address book. A multi-entity operator can then export it and import it into
 * another company context.
 */
export class CreateAddressBookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  /** Snapshot depots into the book. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  includeDepots?: boolean;

  /** Snapshot customers into the book. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  includeCustomers?: boolean;
}

export class UpdateAddressBookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

/**
 * Import a portable address-book payload (exported from another company) as a
 * new saved book in the current company. This is the cross-entity transfer
 * step: the book row always lives in the importing company, so RLS isolation
 * is preserved — only the JSON payload crosses the boundary, never a row.
 */
export class ImportAddressBookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddressBookEntryDto)
  entries!: AddressBookEntryDto[];
}
