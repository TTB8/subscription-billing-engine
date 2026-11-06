/**
 * @file Environment configuration, validated once at boot. A missing or invalid setting stops
 * the server immediately with a clear message; Stripe live keys are refused outright.
 */

import { z } from 'zod';

const TEST_KEY = /^(sk|rk)_test_/;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    ADMIN_API_KEY: z.string().optional(),
    RENEWAL_JOB_ENABLED: z.stringbool().default(true),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.STRIPE_SECRET_KEY && !TEST_KEY.test(env.STRIPE_SECRET_KEY)) {
      fail(
        'STRIPE_SECRET_KEY',
        'must be a Stripe TEST-mode key (sk_test_...); live keys are refused',
      );
    }
    if (env.NODE_ENV === 'test') return;

    if (!env.STRIPE_SECRET_KEY) fail('STRIPE_SECRET_KEY', 'is required outside NODE_ENV=test');
    if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) {
      fail('STRIPE_WEBHOOK_SECRET', 'is required outside NODE_ENV=test and must start with whsec_');
    }
    if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 16) {
      fail('ADMIN_API_KEY', 'is required outside NODE_ENV=test and must be at least 16 characters');
    }
  });

/** The validated, typed configuration the rest of the app reads. */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  appBaseUrl: string;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  /** Undefined means every admin request is rejected. */
  adminApiKey: string | undefined;
  /** Set to false on replicas that should serve the API but not run the renewal schedule. */
  renewalJobEnabled: boolean;
}

/**
 * The environment is invalid. The message lists every problem at once, without echoing any
 * secret value.
 */
export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Injection token for the validated AppConfig. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Validates the environment once, at boot. Empty values count as unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appBaseUrl: e.APP_BASE_URL,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    adminApiKey: e.ADMIN_API_KEY,
    renewalJobEnabled: e.RENEWAL_JOB_ENABLED,
  };
}
