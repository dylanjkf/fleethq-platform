import 'reflect-metadata';

// Staff/admin MFA is enforced by default (fail closed — see
// staff-admin-mfa-policy.ts). The e2e/unit suites provision admin fixtures
// without enrolling MFA, so they deliberately opt this test environment out of
// forced staff MFA. This is the documented non-production opt-out — it is
// ignored in production, so it can never weaken the deployed default. Individual
// specs that assert the policy itself override this per-test.
process.env.ENFORCE_STAFF_ADMIN_MFA = process.env.ENFORCE_STAFF_ADMIN_MFA ?? 'false';
