import { IsString, MaxLength, MinLength } from 'class-validator';

export class ApplyCouponDto {
  /** An existing Stripe Coupon id (created in the Stripe Dashboard/API — this platform doesn't create coupons itself). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  couponId!: string;
}
