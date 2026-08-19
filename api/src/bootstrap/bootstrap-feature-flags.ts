import { PrismaClient } from '@prisma/client';

/**
 * Feature flags that must exist (with a fixed default) in production out of the
 * box. A flag only gates a `@RequireFeatureFlag` route once its row exists —
 * FeatureFlagsService fails OPEN for a missing key. The Warehouse module is
 * still maturing and is hidden by default; seeding its flag `globalEnabled:false`
 * is exactly what hides it, restorably, from day one (an admin flips it on
 * globally, or per-company, from the console — no deploy, no data touched).
 *
 * Kept in its own side-effect-free module (prod-bootstrap.ts runs `main()` at
 * import time) so it can be imported by tests without booting the bootstrapper.
 */
export const BOOTSTRAP_FEATURE_FLAGS: { key: string; name: string; description: string; globalEnabled: boolean }[] = [
  {
    key: 'warehouse',
    name: 'Warehouse',
    description:
      'Warehouse & inventory add-on (stock, machines, machine maintenance schedules). Hidden by default while the module matures; turn on globally or per-company to reveal it.',
    globalEnabled: false,
  },
];

/**
 * Idempotent AND non-clobbering: only ever CREATE the row. If an admin later
 * turns a flag on (globalEnabled=true, or a per-company override) from the
 * console, a subsequent boot must NOT reset it — so the upsert's `update` is a
 * no-op.
 */
export async function seedFeatureFlags(prisma: PrismaClient): Promise<void> {
  for (const flag of BOOTSTRAP_FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: {},
      create: { key: flag.key, name: flag.name, description: flag.description, globalEnabled: flag.globalEnabled },
    });
  }
  console.log(
    `[bootstrap] feature flags ensured (${BOOTSTRAP_FEATURE_FLAGS.map((f) => `${f.key}=${f.globalEnabled ? 'on' : 'off'} by default`).join(', ')}) — create-only, admin toggles are preserved.`,
  );
}
