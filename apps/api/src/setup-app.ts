/**
 * @file Global HTTP behaviour shared by the real server and the e2e tests, so tests exercise
 * exactly what production runs: strict request validation and the error mapping.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { BillingExceptionFilter } from './common/billing-exception.filter';

/** Shared by the real server and the e2e tests so both behave identically. */
export function setupApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new BillingExceptionFilter());
}
