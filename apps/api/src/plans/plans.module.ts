/**
 * @file Plan catalogue.
 */

import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/** Plan listing and creation. */
@Module({ controllers: [PlansController], providers: [PlansService] })
export class PlansModule {}
