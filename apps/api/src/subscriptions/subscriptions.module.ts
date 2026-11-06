/**
 * @file Subscription lifecycle for customers.
 */

import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/** Checkout, status, pause and cancel. */
@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService] })
export class SubscriptionsModule {}
