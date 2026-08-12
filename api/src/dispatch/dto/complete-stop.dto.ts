import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FormAnswerDto } from '../../forms/dto/form-answer.dto';

/**
 * Configurable POD evidence (docs/design/Configurable_POD.md): the answers to
 * the tenant's DELIVERY form template, captured once and shared across the
 * stop's parcels. `answers` follows the form engine's shape — a photo/signature
 * answer's value is a `{ contentType, filename?, base64 }` payload; text/select
 * answers are their plain value. Validated server-side against the DELIVERY
 * template's CURRENT fields, so a required photo can't be omitted.
 */
export class PodEvidenceDto {
  /** Optional client-generated submission id for idempotent offline replay. */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FormAnswerDto)
  answers!: FormAnswerDto[];
}

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

  /**
   * Multi-drop (docs/design/Configurable_POD.md): which of the stop's parcels
   * this confirmation covers. Omitted → every parcel at the stop. Each covered
   * parcel is individually marked delivered (its own `deliveredAt`) while
   * sharing the one evidence capture below.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  parcelIds?: string[];

  /**
   * The configured Proof-of-Delivery evidence. Required on a DELIVERED outcome
   * iff the tenant has an active DELIVERY form template; ignored on FAILED. When
   * no DELIVERY template is configured, the legacy podPhotoBase64/signatureBase64
   * fields above still apply (backward compatible).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PodEvidenceDto)
  evidence?: PodEvidenceDto;
}
