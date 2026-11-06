/**
 * @file The renewal and dunning-retry job.
 */

import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { RenewalsController } from './renewals.controller';
import { RenewalsScheduler } from './renewals.scheduler';
import { RenewalsService } from './renewals.service';

/** Renewal job, its schedule and its admin trigger. */
@Module({
  imports: [BillingModule],
  controllers: [RenewalsController],
  providers: [RenewalsService, RenewalsScheduler],
})
export class RenewalsModule {}
