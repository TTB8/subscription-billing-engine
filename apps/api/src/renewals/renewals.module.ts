import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { RenewalsController } from './renewals.controller';
import { RenewalsScheduler } from './renewals.scheduler';
import { RenewalsService } from './renewals.service';

@Module({
  imports: [BillingModule],
  controllers: [RenewalsController],
  providers: [RenewalsService, RenewalsScheduler],
})
export class RenewalsModule {}
