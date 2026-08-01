import { IsISO8601, IsOptional } from 'class-validator';

/** Omit `trialEndsAt` (send `null`) to end/clear the trial immediately. */
export class UpdateTrialDto {
  @IsOptional()
  @IsISO8601()
  trialEndsAt?: string | null;
}
