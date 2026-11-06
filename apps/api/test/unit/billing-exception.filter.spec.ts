import { ArgumentsHost } from '@nestjs/common';
import {
  DomainError,
  InvalidArgumentError,
  InvalidTransitionError,
  RefundError,
} from '@billing/domain';
import { GatewayError, GatewayUnavailableError, InvalidSignatureError } from '@billing/gateway';
import { BillingExceptionFilter } from '../../src/common/billing-exception.filter';

function run(error: DomainError | GatewayError) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new BillingExceptionFilter().catch(error, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('BillingExceptionFilter', () => {
  it('maps an invalid transition to 409', () => {
    const { status, body } = run(
      new InvalidTransitionError('Cannot cancel a canceled subscription'),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      error: 'InvalidTransitionError',
      message: expect.stringContaining('canceled'),
    });
  });

  it('maps a refund the ledger does not allow to 409', () => {
    expect(run(new RefundError('already fully refunded')).status).toBe(409);
  });

  it('maps an invalid argument to 400', () => {
    expect(run(new InvalidArgumentError('cycles must be >= 1')).status).toBe(400);
  });

  it('maps any other domain error to 400', () => {
    expect(run(new DomainError('rule broken')).status).toBe(400);
  });

  it('maps a bad webhook signature to 400', () => {
    const { status, body } = run(new InvalidSignatureError());
    expect(status).toBe(400);
    expect(body.message).toBe('Invalid webhook signature');
  });

  it('maps an unreachable provider to 503 without leaking details', () => {
    const { status, body } = run(new GatewayUnavailableError('connect ECONNRESET 10.0.0.1:443'));
    expect(status).toBe(503);
    expect(body.message).not.toContain('10.0.0.1');
  });

  it('maps other provider errors to 502 without leaking details', () => {
    const { status, body } = run(new GatewayError('No such customer: cus_secret_123'));
    expect(status).toBe(502);
    expect(body.message).toBe('Payment provider error');
  });
});
