export interface EmailAttachment {
  filename: string;
  /** Raw file bytes. */
  content: Buffer;
  /** MIME type, e.g. 'application/pdf'. */
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Optional file attachments (e.g. the weekly-report PDF). */
  attachments?: EmailAttachment[];
}

export interface SmsMessage {
  to: string;
  body: string;
}

/**
 * The swap point for a real email/SMS provider. Two implementations exist:
 * `SesNotificationChannel` (real AWS SES email) and
 * `LoggingNotificationChannel` (logs only). NotificationsModule picks between
 * them by config — SES when `EMAIL_PROVIDER=ses` + a verified
 * `EMAIL_FROM_ADDRESS` are set, the logging channel otherwise — so local dev,
 * CI, and an un-provisioned deploy all keep working with zero email config
 * and no call site outside this module changes. SMS is still logging-only in
 * both (no SMS need has surfaced); adding a real SMS channel (SNS/Twilio) is
 * the same one-binding swap when it does.
 */
export interface NotificationChannel {
  sendEmail(message: EmailMessage): Promise<void>;
  sendSms(message: SmsMessage): Promise<void>;
}

export const NOTIFICATION_CHANNEL = Symbol('NOTIFICATION_CHANNEL');
