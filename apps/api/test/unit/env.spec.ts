import { ConfigError, loadConfig } from '../../src/config/env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  STRIPE_SECRET_KEY: 'sk_test_abc123',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
  ADMIN_API_KEY: 'a-long-enough-admin-key',
};

const without = (env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));

const messageOf = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return '';
};

describe('loadConfig', () => {
  it('loads a complete environment with defaults applied', () => {
    expect(loadConfig(base)).toEqual({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: base.DATABASE_URL,
      appBaseUrl: 'http://localhost:3000',
      stripeSecretKey: 'sk_test_abc123',
      stripeWebhookSecret: 'whsec_abc123',
      adminApiKey: base.ADMIN_API_KEY,
      renewalJobEnabled: true,
    });
  });

  it('lets the renewal job be switched off', () => {
    expect(loadConfig({ ...base, RENEWAL_JOB_ENABLED: 'false' }).renewalJobEnabled).toBe(false);
    expect(loadConfig({ ...base, RENEWAL_JOB_ENABLED: 'true' }).renewalJobEnabled).toBe(true);
    expect(messageOf({ ...base, RENEWAL_JOB_ENABLED: 'maybe' })).toContain('RENEWAL_JOB_ENABLED');
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).port).toBe(8080);
  });

  it('fails fast without STRIPE_SECRET_KEY outside test', () => {
    const env = without(base, 'STRIPE_SECRET_KEY');
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(messageOf(env)).toContain('STRIPE_SECRET_KEY: is required outside NODE_ENV=test');
  });

  it('treats an empty value like a missing one (as in a copied .env.example)', () => {
    expect(messageOf({ ...base, STRIPE_SECRET_KEY: '' })).toContain('STRIPE_SECRET_KEY');
  });

  it('allows missing Stripe and admin settings in test', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: base.DATABASE_URL });
    expect(config.stripeSecretKey).toBeUndefined();
    expect(config.adminApiKey).toBeUndefined();
  });

  it('refuses a live-mode key, even in test', () => {
    expect(messageOf({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc' })).toContain('TEST-mode');
    expect(
      messageOf({
        NODE_ENV: 'test',
        DATABASE_URL: base.DATABASE_URL,
        STRIPE_SECRET_KEY: 'sk_live_abc',
      }),
    ).toContain('TEST-mode');
  });

  it('accepts a restricted test key', () => {
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'rk_test_abc' })).not.toThrow();
  });

  it('requires a webhook secret that looks like one', () => {
    expect(messageOf({ ...base, STRIPE_WEBHOOK_SECRET: 'nope' })).toContain(
      'STRIPE_WEBHOOK_SECRET',
    );
  });

  it('requires an admin key of at least 16 characters', () => {
    expect(messageOf({ ...base, ADMIN_API_KEY: 'short' })).toContain('ADMIN_API_KEY');
  });

  it('rejects a bad DATABASE_URL, port, base URL and NODE_ENV, and lists every problem', () => {
    const message = messageOf({
      ...base,
      DATABASE_URL: 'mysql://x',
      PORT: '99999',
      APP_BASE_URL: 'not a url',
      NODE_ENV: 'staging',
    });
    for (const key of ['DATABASE_URL', 'PORT', 'APP_BASE_URL', 'NODE_ENV']) {
      expect(message).toContain(key);
    }
  });

  it('reports a missing DATABASE_URL', () => {
    const env = without(base, 'DATABASE_URL');
    expect(messageOf(env)).toContain('DATABASE_URL');
  });

  it('never prints secret values in its error', () => {
    const message = messageOf({ ...base, STRIPE_SECRET_KEY: 'sk_live_supersecretvalue' });
    expect(message).not.toContain('supersecretvalue');
  });
});
