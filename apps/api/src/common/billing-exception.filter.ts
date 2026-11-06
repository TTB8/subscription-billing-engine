import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import {
  DomainError,
  InvalidArgumentError,
  InvalidTransitionError,
  RefundError,
} from '@billing/domain';
import { GatewayError, GatewayUnavailableError } from '@billing/gateway';
import type { Response } from 'express';

/** Maps domain and gateway errors to HTTP. Provider details are logged, never returned. */
@Catch(DomainError, GatewayError)
export class BillingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Billing');

  catch(error: DomainError | GatewayError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    let status = 400;
    let message = error.message;
    if (error instanceof InvalidTransitionError || error instanceof RefundError) status = 409;
    else if (error instanceof InvalidArgumentError) status = 400;
    else if (error instanceof GatewayUnavailableError) {
      status = 503;
      message = 'Payment provider unavailable, retry shortly';
      this.logger.warn(error.message);
    } else if (error instanceof GatewayError) {
      status = 502;
      message = 'Payment provider error';
      this.logger.error(error.message);
    }

    response.status(status).json({ statusCode: status, error: error.name, message });
  }
}
