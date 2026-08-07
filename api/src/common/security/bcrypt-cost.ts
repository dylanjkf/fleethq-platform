/**
 * The bcrypt work factor (cost) used for every password / backup-code hash on
 * the platform — customer auth, admin auth, MFA backup codes, bootstrap. Read
 * from `BCRYPT_COST` (default 12, the current OWASP-recommended baseline; was a
 * hardcoded 10 everywhere before the security audit) so it can be raised as
 * hardware improves without another code change.
 *
 * Deliberately a plain env read rather than a Nest-injected config value: the
 * same cost must apply in DI services *and* in standalone scripts
 * (prod-bootstrap, create-company-admin) that never build the Nest container.
 *
 * bcrypt encodes its own cost into every hash, so existing cost-10 hashes stay
 * valid and verify normally — this only affects newly created hashes. The value
 * is clamped to a sane range: below 10 is too weak to allow, and bcrypt itself
 * rejects a cost above 31 (and anything past ~15 is impractically slow on login).
 */
const DEFAULT_BCRYPT_COST = 12;
const MIN_BCRYPT_COST = 10;
const MAX_BCRYPT_COST = 15;

export function resolveBcryptCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BCRYPT_COST;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_BCRYPT_COST;
  return Math.min(MAX_BCRYPT_COST, Math.max(MIN_BCRYPT_COST, parsed));
}
