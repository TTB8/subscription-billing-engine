import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '../config/env';
import { AdminKeyGuard } from './admin-key.guard';
import { Clock, SystemClock } from './clock';

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
