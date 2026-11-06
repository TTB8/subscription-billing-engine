/**
 * @file Protection for admin endpoints.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/env';

/**
 * Protects admin endpoints with a shared key in the `x-admin-key` header.
 * Fails closed: with no key configured, nothing gets in. This stands in for
 * real operator authentication, which is out of scope for this repo.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.adminApiKey;
    const given = context.switchToHttp().getRequest<Request>().header('x-admin-key');
    if (!expected || !given) throw new UnauthorizedException();

    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}
