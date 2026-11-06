/**
 * @file Root module. Lists every feature module; the renewal schedule is only registered
 * outside tests.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import { PlansModule } from './plans/plans.module';
import { PrismaModule } from './prisma/prisma.module';
import { RenewalsModule } from './renewals/renewals.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/** The billing API application. */
@Module({
  imports: [
    CommonModule,
    PrismaModule,
    GatewayModule,
    PlansModule,
    SubscriptionsModule,
    PaymentsModule,
    WebhooksModule,
    RenewalsModule,
    // Tests call the job directly; a background timer would only add noise.
    ...(process.env.NODE_ENV === 'test' ? [] : [ScheduleModule.forRoot()]),
  ],
  controllers: [HealthController],
})
export class AppModule {}
