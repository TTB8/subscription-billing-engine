/**
 * @file Admin routes for refunds and the per-subscription ledger.
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { AdminKeyGuard } from '../common/admin-key.guard';
import { LedgerView, RefundDto, RefundView } from './payments.dto';
import { PaymentsService } from './payments.service';

/** Refund a charge and read a subscription's ledger. All routes require the admin key. */
@ApiTags('payments')
@Controller('admin')
@UseGuards(AdminKeyGuard)
@ApiHeader({ name: 'x-admin-key', required: true })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Full refund by default; pass amountCents for a partial one. */
  @Post('payments/:id/refund')
  refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto): Promise<RefundView> {
    return this.payments.refund(id, dto);
  }

  @Get('subscriptions/:id/ledger')
  ledger(@Param('id', ParseUUIDPipe) id: string): Promise<LedgerView> {
    return this.payments.ledger(id);
  }
}
