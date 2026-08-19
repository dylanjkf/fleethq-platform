import { BOOTSTRAP_FEATURE_FLAGS } from './bootstrap-feature-flags';

/**
 * The production default that hides the Warehouse module: prod-bootstrap must
 * seed the `warehouse` feature flag OFF. A flag row only gates a
 * `@RequireFeatureFlag('warehouse')` route once it exists (FeatureFlagsService
 * fails open otherwise), so this default is the whole mechanism that hides the
 * module out of the box — pin it so it can't silently flip to on.
 */
describe('BOOTSTRAP_FEATURE_FLAGS', () => {
  it('seeds the warehouse flag disabled by default', () => {
    const warehouse = BOOTSTRAP_FEATURE_FLAGS.find((f) => f.key === 'warehouse');
    expect(warehouse).toBeDefined();
    expect(warehouse!.globalEnabled).toBe(false);
  });

  it('gives every seeded flag a human-readable name and description', () => {
    for (const flag of BOOTSTRAP_FEATURE_FLAGS) {
      expect(flag.name.length).toBeGreaterThan(0);
      expect(flag.description.length).toBeGreaterThan(0);
    }
  });
});
