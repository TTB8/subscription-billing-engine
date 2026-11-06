/**
 * @file Database access.
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global module providing the Prisma client. */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
