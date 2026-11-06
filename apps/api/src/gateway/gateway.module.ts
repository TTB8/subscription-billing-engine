import { Global, Module } from '@nestjs/common';
import { FakeGateway, PaymentGateway, StripeGateway } from '@billing/gateway';
import { APP_CONFIG, AppConfig } from '../config/env';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Tests run on the in-memory fake. Every other environment talks to Stripe. */
export function createGateway(config: AppConfig): PaymentGateway {
  if (config.nodeEnv === 'test') {
    return new FakeGateway(
      config.stripeWebhookSecret ? { webhookSecret: config.stripeWebhookSecret } : {},
    );
  }
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    throw new Error('Stripe is not configured'); // unreachable: loadConfig enforces both
  }
  return new StripeGateway({
    secretKey: config.stripeSecretKey,
    webhookSecret: config.stripeWebhookSecret,
  });
}

@Global()
@Module({
  providers: [{ provide: PAYMENT_GATEWAY, inject: [APP_CONFIG], useFactory: createGateway }],
  exports: [PAYMENT_GATEWAY],
})
export class GatewayModule {}
