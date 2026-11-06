/** E2E tests: the real Nest app against the billing_test Postgres, with the fake gateway. */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/test/e2e/env.ts'],
  globalSetup: '<rootDir>/test/e2e/global-setup.ts',
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  testTimeout: 30_000,
};
