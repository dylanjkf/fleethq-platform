import { IsBoolean, IsOptional } from 'class-validator';

export class CancelSubscriptionDto {
  /** true = cancel at the end of the current billing period (customer keeps access until then); false/omitted = cancel immediately. */
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;
}
