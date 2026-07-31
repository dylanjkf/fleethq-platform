export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export type AdminLoginResult =
  | { status: 'authenticated'; accessToken: string; admin: { id: string; username: string; fullName: string; mustResetPassword: boolean } }
  | { status: 'mfa_required'; mfaToken: string };

export interface AdminMe {
  id: string;
  username: string;
  email: string;
  fullName: string;
  mfaEnabled: boolean;
  mustResetPassword: boolean;
  role: { id: string; name: string };
  permissions: string[];
}

export interface AdminSessionSummary {
  id: string;
  ipAddress: string;
  userAgent: string | null;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

// ── Organisations ─────────────────────────────────────────────────────────

export type SubscriptionStatus = 'NONE' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

export interface OrganisationSummary {
  id: string;
  name: string;
  jurisdiction: string;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  userCount: number;
}

export interface OrganisationMember {
  membershipId: string;
  userId: string;
  username: string;
  fullName: string;
  email: string | null;
  role: { id: string; name: string };
  accountDisabled: boolean;
  locked: boolean;
  memberSince: string;
}

export interface OrganisationDetail {
  id: string;
  name: string;
  jurisdiction: string;
  subscriptionStatus: SubscriptionStatus;
  planPriceId: string | null;
  trialEndsAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  counts: { assets: number; operators: number; attachedUnits: number };
  users: OrganisationMember[];
}

export interface ImpersonationResult {
  accessToken: string;
  expiresIn: string;
  company: { id: string; name: string };
}

// ── Customer users ────────────────────────────────────────────────────────

export interface CustomerUserDetail {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  emailVerifiedAt: string | null;
  accountDisabled: boolean;
  mfaEnabled: boolean;
  locked: boolean;
  failedLoginCount: number;
  createdAt: string;
  organisations: { companyId: string; companyName: string; role: { id: string; name: string } }[];
}

// ── Analytics ─────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  organisations: { active: number; suspended: number; archived: number; total: number };
  trials: { active: number };
  users: { total: number; newLast30Days: number };
  fleet: { assets: number; operators: number };
  subscriptions: Partial<Record<SubscriptionStatus, number>>;
  churn: { canceledLast30Days: number; windowDays: number };
  revenue: {
    billingConfigured: boolean;
    mrr: number | null;
    arr: number | null;
    currency: string | null;
    byTier: { tier: string; name: string; priceId: string; subscriberCount: number; monthlyUnitAmountCents: number | null }[];
  };
}

export interface DailySignup {
  date: string;
  count: number;
}

export interface TrialExpiring {
  id: string;
  name: string;
  trialEndsAt: string;
  suspended: boolean;
  userCount: number;
}

// ── Billing ───────────────────────────────────────────────────────────────

export interface BillingStatus {
  billingConfigured: boolean;
  subscriptionStatus: SubscriptionStatus;
  planPriceId: string | null;
  trialEndsAt: string | null;
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
  stripe: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string; discounts: unknown[] } | null;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

// ── Support ───────────────────────────────────────────────────────────────

export type AnnouncementSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganisationNote {
  id: string;
  companyId: string;
  adminUserId: string | null;
  body: string;
  createdAt: string;
  adminUser: { id: string; fullName: string; username: string } | null;
}

// ── Feature flags ─────────────────────────────────────────────────────────

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  globalEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganisationFeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  globalEnabled: boolean;
  override: boolean | null;
  effective: boolean;
}

// ── System health ─────────────────────────────────────────────────────────

export interface SystemHealth {
  database: { customerApiConnected: boolean; adminPlatformConnected: boolean };
  process: { uptimeSeconds: number; nodeVersion: string; nodeEnv: string };
  version: { apiVersion: string; deployedCommit: string | null };
  checkedAt: string;
}

// ── Fleet ─────────────────────────────────────────────────────────────────

export interface FleetAsset {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  registration: string | null;
  archivedAt: string | null;
  createdAt: string;
  company: { id: string; name: string };
}

export interface FleetOperator {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  archivedAt: string | null;
  createdAt: string;
  company: { id: string; name: string };
}

export interface FleetIntegration {
  id: string;
  name: string;
  connectorType: 'CSV' | 'REST' | 'WEBHOOK';
  direction: 'IMPORT' | 'EXPORT' | 'BIDIRECTIONAL';
  targetEntity: string;
  isEnabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  archivedAt: string | null;
  createdAt: string;
  company: { id: string; name: string };
}

// ── Audit log ─────────────────────────────────────────────────────────────

export interface AdminAuditLogEntry {
  id: string;
  adminUserId: string | null;
  ipAddress: string;
  userAgent: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  organisationId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  createdAt: string;
  adminUser: { id: string; fullName: string; username: string } | null;
}
