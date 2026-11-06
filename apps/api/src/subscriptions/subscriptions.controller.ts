/**
 * @file Customer-facing subscription routes: start, view, pause and cancel.
 */

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CheckoutDto, CheckoutView, StopView, SubscriptionView } from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

/** Checkout, subscription status, pause and cancel. */
@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post('checkout')
  checkout(@Body() dto: CheckoutDto): Promise<CheckoutView> {
    return this.subscriptions.checkout(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SubscriptionView> {
    return this.subscriptions.get(id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string): Promise<StopView> {
    return this.subscriptions.stop(id, 'pause');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<StopView> {
    return this.subscriptions.stop(id, 'cancel');
  }
}
