/**
 * Threaded from a controller into a service for every admin-platform mutation
 * — who did it (for `AdminAuditService.record`) and where from. Shared across
 * every admin feature module (organisations, customer users, and beyond)
 * rather than declared per-module, since "an admin action's context" is one
 * concept, not one per feature.
 */
export interface AdminActionContext {
  adminUserId: string;
  ip: string | null | undefined;
  userAgent?: string | null;
}
