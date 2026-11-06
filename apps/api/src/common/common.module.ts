/**
 * @file Cross-cutting providers every feature needs: validated configuration, the clock and the
 * admin guard.
 */

import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '../config/env';
import { AdminKeyGuard } from './admin-key.guard';
import { Clock, SystemClock } from './clock';

/** Global module for configuration, time and admin authentication. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Clock, useClass: SystemClock },
    AdminKeyGuard,
  ],
  exports: [APP_CONFIG, Clock, AdminKeyGuard],
})
export class CommonModule {}
