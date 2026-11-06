import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import { PlansModule } from './plans/plans.module';
import { PrismaModule } from './prisma/prisma.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    CommonModule,
    PrismaModule,
    GatewayModule,
    PlansModule,
    SubscriptionsModule,
    PaymentsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
