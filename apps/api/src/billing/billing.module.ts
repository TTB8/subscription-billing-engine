/**
 * @file Shared payment settlement, imported by everything that records a payment result
 * (webhooks and the renewal job).
 */

import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';

/** Provides SettlementService. */
@Module({ providers: [SettlementService], exports: [SettlementService] })
export class BillingModule {}
