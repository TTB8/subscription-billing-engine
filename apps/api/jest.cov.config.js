/**
 * Coverage for the API: unit and e2e tests run as two projects and their
 * coverage is merged, so the number reflects everything that exercises src/.
 * Needs the test database (see jest.e2e.config.js).
 */
const unit = require('./jest.config.js');
// testTimeout is a global option in Jest, so it moves to the top level below.
const { testTimeout, ...e2e } = require('./jest.e2e.config.js');

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    { ...unit, rootDir: __dirname, displayName: 'unit' },
    { ...e2e, rootDir: __dirname, displayName: 'e2e' },
  ],
  testTimeout,
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageReporters: ['text', 'json-summary'],
  // A floor, not a target: it fails the build if a change leaves new code untested.
  coverageThreshold: { global: { statements: 90, lines: 90, functions: 85, branches: 70 } },
};
