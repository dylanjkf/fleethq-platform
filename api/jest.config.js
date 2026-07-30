/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // Each e2e suite's beforeAll builds the whole Nest app against a live DB.
  // With the suite count now past ~48, the default 5s hook timeout gets hit
  // under serial (`--runInBand`) contention even though every suite passes
  // in isolation — this is app-boot time competing for one Postgres, not a
  // real assertion failure. Applies to hooks and tests alike.
  testTimeout: 30000,
  // Each worker holds its own full Nest app + Prisma engine; Jest's default
  // (numCPUs - 1) means 3+ of those alive at once on a 4-vCPU CI runner with
  // only ~7GB total RAM. Past ~85 e2e suites that's tipped into a JS heap OOM
  // during Jest's own teardown/aggregation — every individual suite passes,
  // then the whole process gets SIGABRT'd. Capping workers lowers peak
  // concurrent memory (the actual constraint) rather than just raising the
  // ceiling, which would help less on a fixed-RAM runner.
  maxWorkers: 2,
};
