/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  passWithNoTests: true,
  coverageReporters: ['text', 'json-summary'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: { global: { branches: 95, functions: 100, lines: 98, statements: 98 } },
};
