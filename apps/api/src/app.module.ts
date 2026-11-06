import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { PlansModule } from './plans/plans.module';
import { PrismaModule } from './prisma/prisma.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [CommonModule, PrismaModule, GatewayModule, PlansModule, SubscriptionsModule],
  controllers: [HealthController],
})
export class AppModule {}
