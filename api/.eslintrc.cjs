module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

    // FleetHQ Engineering Constitution — code-size / complexity limits.
    // Enforced here so the standards live in tooling, not just prose, and a
    // regression is caught in CI/IDE rather than in review.
    //
    // Adopted as a ratchet on an existing, healthy codebase: every limit starts
    // as `warn` so it is immediately visible in the IDE and CI without breaking
    // the build on pre-existing, individually-defensible cases, and each rule is
    // promoted to `error` in the wave that drives its violation count to zero
    // (params, depth and file-size are cheap and unambiguous, so they graduate
    // first). max-lines-per-function and complexity are intended to remain
    // `warn`: the Constitution ranks "readability over brevity" and "simplicity
    // over cleverness" above hitting a line count, and a mechanical split of a
    // linear 55-line function or an 11-arm switch usually harms readability.
    // See docs/adr/0001-code-size-and-complexity-limits.md.
    // max-params stays `warn`: NestJS DI constructors legitimately inject 6–8
    // collaborators, which is idiomatic dependency injection, not a "too many
    // arguments" smell — forcing them into a facade would fight the framework.
    // The genuine multi-argument *methods* are refactored to options objects.
    'max-params': ['warn', 5],
    // max-depth graduated to `error` — all production code paths are now ≤3.
    'max-depth': ['error', 3],
    // max-lines graduated to `error` — the 915-line jobs.service god-file was
    // split into JobsService / JobStopsService / JobsSupportService; no
    // production file now exceeds 500 lines.
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
    complexity: ['warn', 10],
  },
  overrides: [
    {
      // Tests legitimately have long describe/it blocks and higher branching in
      // fixtures; the size/complexity limits target production code paths.
      files: ['test/**/*.ts', '**/*.spec.ts', '**/*.e2e-spec.ts'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
        complexity: 'off',
        'max-depth': 'off',
      },
    },
  ],
};
