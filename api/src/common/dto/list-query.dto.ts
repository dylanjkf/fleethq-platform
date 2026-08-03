import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export type SortOrder = 'asc' | 'desc';

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

  /**
   * Client-supplied sort column. Injection-safe by construction: the raw string
   * is never interpolated into a query — it only ever selects a key from an
   * allowlist the service passes to `resolveOrderBy()`, and an unknown value
   * falls back to the service's default order. See `resolveOrderBy`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sort?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: SortOrder;

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

  /**
   * Resolve a Prisma `orderBy` from the client's `sort`/`order`, safely. Only a
   * column in `allowed` (an allowlist the service owns) can be selected; anything
   * else — including a missing or malformed value — yields `fallback`. This is
   * what makes client-supplied sorting injection-safe: the client picks *which*
   * of a fixed set of columns, never supplies the column name itself. `order`
   * defaults to `desc`.
   */
  resolveOrderBy<F extends string>(
    allowed: readonly F[],
    fallback: Record<string, SortOrder>,
  ): Record<string, SortOrder> {
    const dir: SortOrder = this.order === 'asc' ? 'asc' : 'desc';
    if (this.sort && (allowed as readonly string[]).includes(this.sort)) {
      return { [this.sort]: dir };
    }
    return fallback;
  }
}
