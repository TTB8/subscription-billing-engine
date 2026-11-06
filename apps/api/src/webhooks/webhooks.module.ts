/**
 * @file Provider webhook handling.
 */

import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/** Webhook endpoint and event processing. */
@Module({
  imports: [BillingModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
