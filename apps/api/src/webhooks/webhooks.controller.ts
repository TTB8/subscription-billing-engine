import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service';

@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Stripe webhook endpoint. Always answers 2xx once an event is accepted, so
   * the provider stops retrying; it answers 400 only for a bad signature.
   */
  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true; result: string }> {
    if (!signature) throw new BadRequestException('Missing stripe-signature header');
    if (!request.rawBody) throw new BadRequestException('Raw request body unavailable');
    const result = await this.webhooks.handle(request.rawBody, signature);
    return { received: true, result };
  }
}
