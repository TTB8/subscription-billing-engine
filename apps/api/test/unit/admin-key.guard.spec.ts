import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminKeyGuard } from '../../src/common/admin-key.guard';
import { AppConfig } from '../../src/config/env';

const config = (adminApiKey?: string) => ({ adminApiKey }) as AppConfig;

const contextWith = (header?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }),
  }) as unknown as ExecutionContext;

describe('AdminKeyGuard', () => {
  const key = 'correct-admin-key-123';

  it('lets the correct key through', () => {
    expect(new AdminKeyGuard(config(key)).canActivate(contextWith(key))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a wrong key of the same length', 'wrong---admin-key-123'],
    ['a shorter key', 'correct'],
    ['a longer key', `${key}-and-more`],
  ])('rejects %s', (_name, header) => {
    expect(() => new AdminKeyGuard(config(key)).canActivate(contextWith(header))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when no key is configured', () => {
    expect(() => new AdminKeyGuard(config(undefined)).canActivate(contextWith('anything'))).toThrow(
      UnauthorizedException,
    );
    expect(() => new AdminKeyGuard(config(undefined)).canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
