/**
 * @file Refunds and the ledger view.
 */

import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/** Admin refunds and ledger reads. */
@Module({ controllers: [PaymentsController], providers: [PaymentsService] })
export class PaymentsModule {}
