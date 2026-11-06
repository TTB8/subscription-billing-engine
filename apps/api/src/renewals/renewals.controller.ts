/**
 * @file Admin route to run the renewal job on demand.
 */

import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { AdminKeyGuard } from '../common/admin-key.guard';
import { RenewalSummary, RenewalsService } from './renewals.service';

/** Runs the renewal job now. Requires the admin key. */
@ApiTags('renewals')
@Controller('admin/renewals')
@UseGuards(AdminKeyGuard)
@ApiHeader({ name: 'x-admin-key', required: true })
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  /** Runs the renewal job now. Safe to call at any time: charges are idempotent. */
  @Post('run')
  @HttpCode(200)
  run(): Promise<RenewalSummary> {
    return this.renewals.runDue();
  }
}
