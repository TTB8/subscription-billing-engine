/**
 * @file The schedule that runs the renewal job.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { APP_CONFIG, AppConfig } from '../config/env';
import { RenewalsService } from './renewals.service';

/**
 * Runs the renewal job every five minutes. A cycle ends at the exact time the
 * previous payment cleared, so the job polls often and charges what is due.
 * Overlapping runs inside one process are skipped; across processes they are
 * safe because charges are idempotent.
 */
@Injectable()
export class RenewalsScheduler {
  private readonly logger = new Logger('RenewalsScheduler');
  private running = false;

  constructor(
    private readonly renewals: RenewalsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (!this.config.renewalJobEnabled || this.running) return;
    this.running = true;
    try {
      const summary = await this.renewals.runDue();
      if (summary.examined > 0) this.logger.log(`Renewal run: ${JSON.stringify(summary)}`);
    } catch (error) {
      this.logger.error(`Renewal run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
