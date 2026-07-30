/**
 * The closed set of `Notification.type` values raised anywhere in the API
 * today (job assignment, delivery failure, a checklist-raised fault, a new
 * message) — used to validate mute preferences and to let the frontend
 * render a fixed checklist rather than a free-text field. Add a new entry
 * here whenever a new `notifications.notify*InTx` call site introduces a
 * type string that doesn't already appear in this list.
 */
export const NOTIFICATION_TYPES = [
  { key: 'job_assigned', label: 'New job assignments' },
  { key: 'delivery_failed', label: 'Failed deliveries' },
  { key: 'fault_raised', label: 'Workshop jobs raised from a checklist' },
  { key: 'message', label: 'New messages' },
  { key: 'compliance_expiring', label: 'Compliance documents expiring soon' },
  { key: 'compliance_expired', label: 'Compliance documents that have expired' },
] as const;

export const NOTIFICATION_TYPE_KEYS = NOTIFICATION_TYPES.map((t) => t.key) as string[];
