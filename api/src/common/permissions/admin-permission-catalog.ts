/**
 * Single source of truth for the FleetHQ internal administration platform's
 * grantable capabilities (21-Admin-Platform/Overview.md) — deliberately a
 * separate catalog from the customer PERMISSIONS (permission-catalog.ts),
 * even where names overlap, so a change to one can never silently affect
 * the other. Naming convention matches the customer catalog:
 * `<resource>:<action>`.
 */
export const ADMIN_PERMISSIONS = {
  ORGANISATIONS_VIEW: 'organisations:view',
  ORGANISATIONS_CREATE: 'organisations:create',
  ORGANISATIONS_EDIT: 'organisations:edit',
  ORGANISATIONS_SUSPEND: 'organisations:suspend',
  ORGANISATIONS_ARCHIVE: 'organisations:archive',
  ORGANISATIONS_IMPERSONATE: 'organisations:impersonate',
  ORGANISATIONS_EXPORT: 'organisations:export',

  CUSTOMER_USERS_VIEW: 'customer_users:view',
  CUSTOMER_USERS_MANAGE: 'customer_users:manage',

  BILLING_VIEW: 'billing:view',
  BILLING_MANAGE: 'billing:manage',

  SUPPORT_VIEW: 'support:view',
  SUPPORT_MANAGE: 'support:manage',

  FEATURE_FLAGS_VIEW: 'feature_flags:view',
  FEATURE_FLAGS_MANAGE: 'feature_flags:manage',

  FLEET_VIEW: 'fleet:view',

  INSPECTIONS_VIEW: 'inspections:view',

  MAINTENANCE_VIEW: 'maintenance:view',
  MAINTENANCE_MANAGE: 'maintenance:manage',

  SYSTEM_VIEW: 'system:view',

  ANALYTICS_VIEW: 'analytics:view',

  ADMIN_USERS_VIEW: 'admin_users:view',
  ADMIN_USERS_MANAGE: 'admin_users:manage',

  AUDIT_LOG_VIEW: 'audit_log:view',
} as const;

export type AdminPermissionKey = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

export interface AdminPermissionCatalogEntry {
  key: AdminPermissionKey;
  category: string;
  description: string;
}

export const ADMIN_PERMISSION_CATALOG: AdminPermissionCatalogEntry[] = [
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_VIEW, category: 'Organisations', description: 'View organisation records and activity' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_CREATE, category: 'Organisations', description: 'Create new organisations' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_EDIT, category: 'Organisations', description: 'Edit organisation details, plan, and trial' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_SUSPEND, category: 'Organisations', description: 'Suspend or restore an organisation' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_ARCHIVE, category: 'Organisations', description: 'Archive (soft delete) or restore an organisation' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_IMPERSONATE, category: 'Organisations', description: 'Impersonate a customer user for support purposes' },
  { key: ADMIN_PERMISSIONS.ORGANISATIONS_EXPORT, category: 'Organisations', description: 'Export an organisation\'s data' },

  { key: ADMIN_PERMISSIONS.CUSTOMER_USERS_VIEW, category: 'Customer Users', description: 'View customer user accounts and login history' },
  { key: ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE, category: 'Customer Users', description: 'Disable/reactivate/reset customer user accounts' },

  { key: ADMIN_PERMISSIONS.BILLING_VIEW, category: 'Billing', description: 'View subscriptions, invoices, and payment history' },
  { key: ADMIN_PERMISSIONS.BILLING_MANAGE, category: 'Billing', description: 'Issue refunds, coupons, manual invoices, and change plans' },

  { key: ADMIN_PERMISSIONS.SUPPORT_VIEW, category: 'Support', description: 'View support tools and internal notes' },
  { key: ADMIN_PERMISSIONS.SUPPORT_MANAGE, category: 'Support', description: 'Resend invitations/verification, reset MFA, manage announcements' },

  { key: ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW, category: 'Feature Flags', description: 'View feature flags and rollout status' },
  { key: ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE, category: 'Feature Flags', description: 'Create, enable, disable, and target feature flags' },

  { key: ADMIN_PERMISSIONS.FLEET_VIEW, category: 'Fleet Administration', description: 'View cross-tenant assets, operators, and integrations' },

  { key: ADMIN_PERMISSIONS.INSPECTIONS_VIEW, category: 'Inspections', description: 'View cross-tenant checklist inspections and submissions' },

  { key: ADMIN_PERMISSIONS.MAINTENANCE_VIEW, category: 'Maintenance', description: 'View cross-tenant maintenance jobs and defects' },
  { key: ADMIN_PERMISSIONS.MAINTENANCE_MANAGE, category: 'Maintenance', description: 'Reassign, comment on, and close maintenance defects' },

  { key: ADMIN_PERMISSIONS.SYSTEM_VIEW, category: 'System', description: 'View system/database health and deployment info' },

  { key: ADMIN_PERMISSIONS.ANALYTICS_VIEW, category: 'Analytics', description: 'View the executive dashboard and analytics' },

  { key: ADMIN_PERMISSIONS.ADMIN_USERS_VIEW, category: 'Administration', description: 'View FleetHQ staff accounts and roles' },
  { key: ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE, category: 'Administration', description: 'Create/disable FleetHQ staff accounts and assign roles' },

  { key: ADMIN_PERMISSIONS.AUDIT_LOG_VIEW, category: 'Administration', description: 'View the administration platform\'s own audit log' },
];
