import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const DEFAULT_PAGE_SIZE = 25;
/** Shared hard cap for every list endpoint's page size / limit query param. */
export const MAX_PAGE_SIZE = 200;

/** Shared pagination shape for every registry list endpoint. */
export class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean = false;

  /**
   * Free-text filter. Applied server-side so it matches across the *whole*
   * result set, not just the current page — a client-side filter over one
   * fetched page silently misses matches on every later page. Each service
   * decides which columns it searches (see `searchWhere`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  get skip(): number {
    return ((this.page ?? 1) - 1) * (this.pageSize ?? DEFAULT_PAGE_SIZE);
  }

  get take(): number {
    return this.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  /** Normalised search term, or undefined when blank. */
  get searchTerm(): string | undefined {
    const trimmed = this.search?.trim();
    return trimmed ? trimmed : undefined;
  }
}
