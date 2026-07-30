import { IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const STOP_COMPLETION_OUTCOMES = ['DELIVERED', 'FAILED'] as const;
export type StopCompletionOutcome = (typeof STOP_COMPLETION_OUTCOMES)[number];

export const STOP_FAILURE_REASONS = [
  'NOBODY_HOME',
  'ACCESS_DENIED',
  'BUSINESS_CLOSED',
  'ADDRESS_ISSUE',
  'REFUSED',
  'OTHER',
] as const;
export type StopFailureReasonInput = (typeof STOP_FAILURE_REASONS)[number];

export class CompleteStopDto {
  @IsIn(STOP_COMPLETION_OUTCOMES)
  outcome!: StopCompletionOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * A defined reason for a FAILED outcome. Optional (not required) so this
   * stays additive over the existing free-text `note` — a fleet can start
   * using it without every historical/edge-case fail needing to classify one.
   * The service rejects a reason paired with DELIVERED (an inconsistent pair).
   */
  @IsOptional()
  @IsIn(STOP_FAILURE_REASONS)
  failureReason?: StopFailureReasonInput;

  /**
   * When the delivery actually happened, stamped on the device. Sent by DriverOS
   * so an offline completion that syncs later is recorded at the real delivery
   * time, not sync time. Optional and untrusted: the service clamps it (never
   * accepts a future time, ignores anything implausibly old), so a wrong device
   * clock can't corrupt on-time reporting.
   */
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  /** Optional proof photo, base64 (raw or data URL). Stored as an Attachment inline. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  podPhotoBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  podPhotoContentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  podPhotoFilename?: string;

  /** Optional recipient signature captured on a canvas, base64 PNG (raw or data URL). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  signatureBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  signatureContentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  signatureFilename?: string;
}
