// Runs before any module loads, so the app and Prisma see the test configuration.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://billing:billing@localhost:5433/billing_test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e';
delete process.env.STRIPE_SECRET_KEY;
