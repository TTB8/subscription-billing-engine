/** Unit tests: no database, no network. */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
};
