import { IsInt, Max, Min } from 'class-validator';

/**
 * Body for POST /v1/billing/quantity — the customer's "buy more / release
 * asset slots" action on the per-asset plan. `quantity` is the new total number
 * of paid asset slots (the hard cap), not a delta.
 */
export class ChangeAssetQuantityDto {
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;
}
