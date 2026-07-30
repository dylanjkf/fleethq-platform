/**
 * Single source of truth for grantable capabilities (14-Security/Permissions_Model.md:
 * "every feature/action in the platform maps to an individually grantable
 * permission"). The seed script loads this list into the `permissions` table;
 * the @RequirePermission decorator references these keys so a typo is a
 * compile error, not a silent always-false check.
 *
 * Naming convention: `<resource>:<action>`. No "delete" action anywhere —
 * Data_Model.md forbids hard deletes on entities with Timeline relevance, so
 * the destructive-sounding capability is always "archive".
 */
export const PERMISSIONS = {
  ASSETS_VIEW: 'assets:view',
  ASSETS_CREATE: 'assets:create',
  ASSETS_EDIT: 'assets:edit',
  ASSETS_ARCHIVE: 'assets:archive',

  OPERATORS_VIEW: 'operators:view',
  OPERATORS_CREATE: 'operators:create',
  OPERATORS_EDIT: 'operators:edit',
  OPERATORS_ARCHIVE: 'operators:archive',

  COMPANIES_VIEW: 'companies:view',
  COMPANIES_EDIT: 'companies:edit',

  USERS_VIEW: 'users:view',
  USERS_CREATE: 'users:create',
  USERS_EDIT: 'users:edit',
  USERS_ARCHIVE: 'users:archive',

  ROLES_VIEW: 'roles:view',
  ROLES_CREATE: 'roles:create',
  ROLES_EDIT: 'roles:edit',
  ROLES_ARCHIVE: 'roles:archive',

  ATTACHED_UNITS_VIEW: 'attached_units:view',
  ATTACHED_UNITS_CREATE: 'attached_units:create',
  ATTACHED_UNITS_EDIT: 'attached_units:edit',
  ATTACHED_UNITS_ARCHIVE: 'attached_units:archive',

  DISPATCH_VIEW: 'dispatch:view',
  DISPATCH_CREATE: 'dispatch:create',
  DISPATCH_EDIT: 'dispatch:edit',
  DISPATCH_ASSIGN: 'dispatch:assign',
  DISPATCH_CANCEL: 'dispatch:cancel',
  DISPATCH_DELIVER: 'dispatch:deliver',

  LOCATION_REPORT: 'locations:report',
  LOCATION_VIEW: 'locations:view',

  MAINTENANCE_VIEW: 'maintenance:view',
  MAINTENANCE_CREATE: 'maintenance:create',
  MAINTENANCE_EDIT: 'maintenance:edit',
  MAINTENANCE_APPROVE: 'maintenance:approve',
  MAINTENANCE_CLOSE: 'maintenance:close',

  COMPLIANCE_VIEW: 'compliance:view',
  COMPLIANCE_CREATE: 'compliance:create',
  COMPLIANCE_EDIT: 'compliance:edit',
  COMPLIANCE_ARCHIVE: 'compliance:archive',

  CHECKLISTS_VIEW: 'checklists:view',
  CHECKLISTS_CREATE: 'checklists:create',
  CHECKLISTS_EDIT: 'checklists:edit',
  CHECKLISTS_ARCHIVE: 'checklists:archive',
  CHECKLISTS_SUBMIT: 'checklists:submit',

  MESSAGES_VIEW: 'messages:view',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_BROADCAST: 'messages:broadcast',

  ATTACHMENTS_VIEW: 'attachments:view',
  ATTACHMENTS_UPLOAD: 'attachments:upload',

  REPORTS_VIEW: 'reports:view',

  CUSTOMERS_VIEW: 'customers:view',
  CUSTOMERS_CREATE: 'customers:create',
  CUSTOMERS_EDIT: 'customers:edit',
  CUSTOMERS_ARCHIVE: 'customers:archive',

  DEPOTS_VIEW: 'depots:view',
  DEPOTS_CREATE: 'depots:create',
  DEPOTS_EDIT: 'depots:edit',
  DEPOTS_ARCHIVE: 'depots:archive',
  SHIFTS_VIEW: 'shifts:view',
  SHIFTS_MANAGE: 'shifts:manage',
  TIMELINE_VIEW: 'timeline:view',
  NOTIFICATIONS_DIGEST_SEND: 'notifications_digest:send',

  PRIVACY_EXPORT_DATA: 'privacy:export',
  PRIVACY_ERASE_DATA: 'privacy:erase',

  AUDIT_VIEW: 'audit:view',

  FLEET_GRAPH_VIEW: 'fleet_graph:view',

  FORMS_VIEW: 'forms:view',
  FORMS_CREATE: 'forms:create',
  FORMS_EDIT: 'forms:edit',
  FORMS_ARCHIVE: 'forms:archive',
  FORMS_SUBMIT: 'forms:submit',

  PARTS_VIEW: 'parts:view',
  PARTS_CREATE: 'parts:create',
  PARTS_EDIT: 'parts:edit',
  PARTS_ARCHIVE: 'parts:archive',

  BILLING_VIEW: 'billing:view',
  BILLING_MANAGE: 'billing:manage',

  DOCUMENTS_VIEW: 'documents:view',
  DOCUMENTS_CREATE: 'documents:create',
  DOCUMENTS_ARCHIVE: 'documents:archive',

  KNOWLEDGE_VIEW: 'knowledge:view',
  KNOWLEDGE_CREATE: 'knowledge:create',
  KNOWLEDGE_ARCHIVE: 'knowledge:archive',

  FUEL_VIEW: 'fuel:view',
  FUEL_LOG: 'fuel:log',
  WAREHOUSE_VIEW: 'warehouse:view',
  WAREHOUSE_MANAGE: 'warehouse:manage',

  FATIGUE_MANAGE: 'fatigue:manage',

  NOTIFICATIONS_MANAGE: 'notifications:manage',
  DASHBOARD_MANAGE: 'dashboard:manage',
  ADDRESS_BOOK_MANAGE: 'address_book:manage',
  ASSET_CLASS_MANAGE: 'asset_class:manage',
  GPS_DEVICE_MANAGE: 'gps_device:manage',
  ANALYTICS_MANAGE: 'analytics:manage',
  BARCODE_CONFIG_MANAGE: 'barcode_config:manage',

  INTEGRATIONS_VIEW: 'integrations:view',
  INTEGRATIONS_MANAGE: 'integrations:manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionCatalogEntry {
  key: PermissionKey;
  category: string;
  description: string;
}

export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { key: PERMISSIONS.ASSETS_VIEW, category: 'Assets', description: 'View asset records' },
  { key: PERMISSIONS.ASSETS_CREATE, category: 'Assets', description: 'Create new assets' },
  { key: PERMISSIONS.ASSETS_EDIT, category: 'Assets', description: 'Edit existing assets' },
  { key: PERMISSIONS.ASSETS_ARCHIVE, category: 'Assets', description: 'Archive assets' },

  { key: PERMISSIONS.OPERATORS_VIEW, category: 'Operators', description: 'View operator records' },
  { key: PERMISSIONS.OPERATORS_CREATE, category: 'Operators', description: 'Create new operators' },
  { key: PERMISSIONS.OPERATORS_EDIT, category: 'Operators', description: 'Edit existing operators' },
  { key: PERMISSIONS.OPERATORS_ARCHIVE, category: 'Operators', description: 'Archive operators' },

  { key: PERMISSIONS.COMPANIES_VIEW, category: 'Company', description: 'View company profile settings' },
  { key: PERMISSIONS.COMPANIES_EDIT, category: 'Company', description: 'Edit company profile settings' },

  { key: PERMISSIONS.USERS_VIEW, category: 'Users', description: 'View company users and their roles' },
  { key: PERMISSIONS.USERS_CREATE, category: 'Users', description: 'Create/invite new users' },
  { key: PERMISSIONS.USERS_EDIT, category: 'Users', description: "Change a user's role" },
  { key: PERMISSIONS.USERS_ARCHIVE, category: 'Users', description: 'Deactivate a user' },

  { key: PERMISSIONS.ROLES_VIEW, category: 'Roles', description: 'View roles and their permissions' },
  { key: PERMISSIONS.ROLES_CREATE, category: 'Roles', description: 'Create or clone roles' },
  { key: PERMISSIONS.ROLES_EDIT, category: 'Roles', description: "Edit a role's name or permission set" },
  { key: PERMISSIONS.ROLES_ARCHIVE, category: 'Roles', description: 'Archive a role' },

  { key: PERMISSIONS.ATTACHED_UNITS_VIEW, category: 'Attached Units', description: 'View attached unit records' },
  { key: PERMISSIONS.ATTACHED_UNITS_CREATE, category: 'Attached Units', description: 'Create new attached units' },
  { key: PERMISSIONS.ATTACHED_UNITS_EDIT, category: 'Attached Units', description: 'Edit existing attached units' },
  { key: PERMISSIONS.ATTACHED_UNITS_ARCHIVE, category: 'Attached Units', description: 'Archive attached units' },

  { key: PERMISSIONS.DISPATCH_VIEW, category: 'Dispatch', description: 'View jobs' },
  { key: PERMISSIONS.DISPATCH_CREATE, category: 'Dispatch', description: 'Create new jobs' },
  { key: PERMISSIONS.DISPATCH_EDIT, category: 'Dispatch', description: 'Edit job details and mark jobs complete' },
  { key: PERMISSIONS.DISPATCH_ASSIGN, category: 'Dispatch', description: 'Assign or reassign a job to an asset/operator' },
  { key: PERMISSIONS.DISPATCH_CANCEL, category: 'Dispatch', description: 'Cancel a job' },
  { key: PERMISSIONS.DISPATCH_DELIVER, category: 'Dispatch', description: 'Complete a delivery stop with proof (DriverOS operators)' },

  { key: PERMISSIONS.LOCATION_REPORT, category: 'Location', description: 'Report your own live location while on shift (DriverOS operators)' },
  { key: PERMISSIONS.LOCATION_VIEW, category: 'Location', description: "See on-shift operators' live location on the dispatch board" },

  { key: PERMISSIONS.MAINTENANCE_VIEW, category: 'Maintenance', description: 'View maintenance jobs' },
  { key: PERMISSIONS.MAINTENANCE_CREATE, category: 'Maintenance', description: 'Log new maintenance jobs' },
  { key: PERMISSIONS.MAINTENANCE_EDIT, category: 'Maintenance', description: 'Edit maintenance job details and status' },
  { key: PERMISSIONS.MAINTENANCE_APPROVE, category: 'Maintenance', description: 'Approve a maintenance job before spend' },
  { key: PERMISSIONS.MAINTENANCE_CLOSE, category: 'Maintenance', description: 'Close a completed maintenance job' },

  { key: PERMISSIONS.COMPLIANCE_VIEW, category: 'Compliance', description: 'View compliance documents and expiry status' },
  { key: PERMISSIONS.COMPLIANCE_CREATE, category: 'Compliance', description: 'Log new compliance documents' },
  { key: PERMISSIONS.COMPLIANCE_EDIT, category: 'Compliance', description: 'Edit existing compliance documents' },
  { key: PERMISSIONS.COMPLIANCE_ARCHIVE, category: 'Compliance', description: 'Archive a compliance document' },

  { key: PERMISSIONS.CHECKLISTS_VIEW, category: 'Checklists', description: 'View checklist templates and completed submissions' },
  { key: PERMISSIONS.CHECKLISTS_CREATE, category: 'Checklists', description: 'Create new checklist templates' },
  { key: PERMISSIONS.CHECKLISTS_EDIT, category: 'Checklists', description: 'Edit existing checklist templates' },
  { key: PERMISSIONS.CHECKLISTS_ARCHIVE, category: 'Checklists', description: 'Archive a checklist template' },
  { key: PERMISSIONS.CHECKLISTS_SUBMIT, category: 'Checklists', description: 'Complete and submit a checklist (DriverOS operators)' },

  { key: PERMISSIONS.MESSAGES_VIEW, category: 'Messages', description: 'View operator ↔ office message threads' },
  { key: PERMISSIONS.MESSAGES_SEND, category: 'Messages', description: 'Send a message in an operator ↔ office thread' },
  { key: PERMISSIONS.MESSAGES_BROADCAST, category: 'Messages', description: 'Send one message to every operator at once (broadcast)' },

  { key: PERMISSIONS.ATTACHMENTS_VIEW, category: 'Attachments', description: 'View/download stored photos and files' },
  { key: PERMISSIONS.ATTACHMENTS_UPLOAD, category: 'Attachments', description: 'Upload photos and files (proof of delivery, fault photos)' },

  { key: PERMISSIONS.REPORTS_VIEW, category: 'Reports', description: 'View operational reports' },

  { key: PERMISSIONS.CUSTOMERS_VIEW, category: 'Customers', description: 'View customer records' },
  { key: PERMISSIONS.CUSTOMERS_CREATE, category: 'Customers', description: 'Create new customers' },
  { key: PERMISSIONS.CUSTOMERS_EDIT, category: 'Customers', description: 'Edit existing customers' },
  { key: PERMISSIONS.CUSTOMERS_ARCHIVE, category: 'Customers', description: 'Archive a customer' },

  { key: PERMISSIONS.DEPOTS_VIEW, category: 'Depots', description: 'View depot/branch locations' },
  { key: PERMISSIONS.DEPOTS_CREATE, category: 'Depots', description: 'Create new depots' },
  { key: PERMISSIONS.DEPOTS_EDIT, category: 'Depots', description: 'Edit existing depots' },
  { key: PERMISSIONS.DEPOTS_ARCHIVE, category: 'Depots', description: 'Archive a depot' },
  { key: PERMISSIONS.SHIFTS_VIEW, category: 'Shifts', description: 'View shift history and the day summary' },
  { key: PERMISSIONS.SHIFTS_MANAGE, category: 'Shifts', description: "Start/end the caller's own shift" },
  { key: PERMISSIONS.TIMELINE_VIEW, category: 'Timeline', description: 'View an entity\'s audit timeline' },
  { key: PERMISSIONS.NOTIFICATIONS_DIGEST_SEND, category: 'Notifications', description: 'Send the email digest for unread notifications' },

  { key: PERMISSIONS.PRIVACY_EXPORT_DATA, category: 'Privacy', description: "Export an operator's personal data (Australian Privacy Act access request)" },
  { key: PERMISSIONS.PRIVACY_ERASE_DATA, category: 'Privacy', description: "Erase an archived operator's personal data (Australian Privacy Act erasure request)" },
  { key: PERMISSIONS.AUDIT_VIEW, category: 'Security', description: 'View the company security audit log' },

  { key: PERMISSIONS.FLEET_GRAPH_VIEW, category: 'Fleet Graph', description: "View an entity's Fleet Graph relationships (e.g. which operators have operated this asset)" },

  { key: PERMISSIONS.FORMS_VIEW, category: 'Forms', description: 'View form templates and completed submissions' },
  { key: PERMISSIONS.FORMS_CREATE, category: 'Forms', description: 'Create new form templates' },
  { key: PERMISSIONS.FORMS_EDIT, category: 'Forms', description: "Edit a form template's fields" },
  { key: PERMISSIONS.FORMS_ARCHIVE, category: 'Forms', description: 'Archive a form template' },
  { key: PERMISSIONS.FORMS_SUBMIT, category: 'Forms', description: 'Complete and submit a form' },

  { key: PERMISSIONS.PARTS_VIEW, category: 'Parts', description: 'View the parts catalog and stock levels' },
  { key: PERMISSIONS.PARTS_CREATE, category: 'Parts', description: 'Create new parts and log parts used against a maintenance job' },
  { key: PERMISSIONS.PARTS_EDIT, category: 'Parts', description: 'Edit part details and adjust stock levels' },
  { key: PERMISSIONS.PARTS_ARCHIVE, category: 'Parts', description: 'Archive a part' },

  { key: PERMISSIONS.BILLING_VIEW, category: 'Finance', description: "View the company's subscription plan and status" },
  { key: PERMISSIONS.BILLING_MANAGE, category: 'Finance', description: 'Manage billing — subscribe, change plan, update payment method' },

  { key: PERMISSIONS.DOCUMENTS_VIEW, category: 'Documents', description: 'View and download company documents' },
  { key: PERMISSIONS.DOCUMENTS_CREATE, category: 'Documents', description: 'Upload company documents' },
  { key: PERMISSIONS.DOCUMENTS_ARCHIVE, category: 'Documents', description: 'Archive a company document' },
  { key: PERMISSIONS.KNOWLEDGE_VIEW, category: 'Knowledge Base', description: 'Read published knowledge base articles' },
  { key: PERMISSIONS.KNOWLEDGE_CREATE, category: 'Knowledge Base', description: 'Write, edit, and publish knowledge base articles' },
  { key: PERMISSIONS.KNOWLEDGE_ARCHIVE, category: 'Knowledge Base', description: 'Archive a knowledge base article' },
  { key: PERMISSIONS.FUEL_VIEW, category: 'Fuel', description: 'View fuel-card purchases and spend' },
  { key: PERMISSIONS.FUEL_LOG, category: 'Fuel', description: 'Record a fuel purchase (drivers, from DriverOS)' },
  { key: PERMISSIONS.WAREHOUSE_VIEW, category: 'Warehouse', description: 'View warehouse stock and machines' },
  { key: PERMISSIONS.WAREHOUSE_MANAGE, category: 'Warehouse', description: 'Add and edit warehouse stock, machines, and maintenance logs' },
  { key: PERMISSIONS.FATIGUE_MANAGE, category: 'Compliance', description: 'Create and deploy custom fatigue rule sets' },
  { key: PERMISSIONS.NOTIFICATIONS_MANAGE, category: 'Administration', description: 'Create and deploy notification preset bundles to users' },
  { key: PERMISSIONS.DASHBOARD_MANAGE, category: 'Administration', description: 'Create and deploy dashboard layouts to users' },
  { key: PERMISSIONS.ADDRESS_BOOK_MANAGE, category: 'Administration', description: 'Export and import depot/customer address books' },
  { key: PERMISSIONS.ASSET_CLASS_MANAGE, category: 'Administration', description: 'Create and manage custom asset categories' },
  { key: PERMISSIONS.GPS_DEVICE_MANAGE, category: 'Administration', description: 'Register and manage GPS trackers on assets' },
  { key: PERMISSIONS.ANALYTICS_MANAGE, category: 'Administration', description: 'Adjust analytics targets, override or reset dashboard percentages, and exclude data points' },
  { key: PERMISSIONS.BARCODE_CONFIG_MANAGE, category: 'Administration', description: 'Configure barcode scan mode, searchable fields, and field mappings' },

  { key: PERMISSIONS.INTEGRATIONS_VIEW, category: 'Integrations', description: 'View integration connections, sync history, and logs' },
  { key: PERMISSIONS.INTEGRATIONS_MANAGE, category: 'Integrations', description: 'Create/edit integration connections, credentials, field mappings, and webhooks; trigger syncs' },
];

/**
 * The DriverOS permission bundle — everything a driver login needs to do their
 * job in the field: complete inspections and forms, deliver stops with proof,
 * report their location while on shift, start/end their shift, log fuel, and
 * message the office (view + send). Seeded as a "Driver" system role so
 * provisioning a driver is correct-by-default; previously the office had to
 * hand-build a role and it was easy to forget an action like `messages:send`,
 * which silently blocked drivers from replying.
 */
export const DRIVER_ROLE_PERMISSION_KEYS: PermissionKey[] = [
  PERMISSIONS.ASSETS_VIEW,
  PERMISSIONS.COMPLIANCE_VIEW,
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.LOCATION_REPORT,
  PERMISSIONS.CHECKLISTS_VIEW,
  PERMISSIONS.CHECKLISTS_SUBMIT,
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.FORMS_SUBMIT,
  PERMISSIONS.MESSAGES_VIEW,
  PERMISSIONS.MESSAGES_SEND,
  PERMISSIONS.SHIFTS_VIEW,
  PERMISSIONS.SHIFTS_MANAGE,
  PERMISSIONS.FUEL_LOG,
  PERMISSIONS.ATTACHMENTS_VIEW,
  PERMISSIONS.ATTACHMENTS_UPLOAD,
];
