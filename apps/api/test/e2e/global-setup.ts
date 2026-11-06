import { execSync } from 'node:child_process';

/** Brings the test database up to the latest migration. Never resets anything. */
export default function globalSetup(): void {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://billing:billing@localhost:5433/billing_test';
  execSync('pnpm exec prisma migrate deploy', {
    cwd: __dirname + '/../..',
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
