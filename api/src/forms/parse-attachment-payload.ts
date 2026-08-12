import { BadRequestException } from '@nestjs/common';

/**
 * Parse and validate a `photo`/`signature` form answer's file payload
 * (Configurable POD — docs/design/Configurable_POD.md). The client sends
 * `{ contentType, filename?, base64 }`; the service stores it via
 * AttachmentsService and persists the resulting attachment id as the answer.
 * Extracted from FormsService to keep that file under the 500-line ceiling.
 */
export function parseAttachmentPayload(
  fieldLabel: string,
  value: unknown,
): { contentType: string; filename?: string; base64: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException({
      code: 'FORM_INVALID_VALUE',
      message: `Field "${fieldLabel}" must be a { contentType, base64 } file payload.`,
    });
  }
  const v = value as Record<string, unknown>;
  if (typeof v.contentType !== 'string' || typeof v.base64 !== 'string' || v.base64.length === 0) {
    throw new BadRequestException({
      code: 'FORM_INVALID_VALUE',
      message: `Field "${fieldLabel}" needs a contentType and non-empty base64 payload.`,
    });
  }
  if (v.filename !== undefined && typeof v.filename !== 'string') {
    throw new BadRequestException({
      code: 'FORM_INVALID_VALUE',
      message: `Field "${fieldLabel}" filename must be a string.`,
    });
  }
  return { contentType: v.contentType, filename: v.filename as string | undefined, base64: v.base64 };
}
