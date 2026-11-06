import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { AdminKeyGuard } from '../common/admin-key.guard';
import { CreatePlanDto, PlanView } from './plans.dto';
import { PlansService } from './plans.service';

@ApiTags('plans')
@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('plans')
  list(): Promise<PlanView[]> {
    return this.plans.list();
  }

  @Post('admin/plans')
  @UseGuards(AdminKeyGuard)
  @ApiHeader({ name: 'x-admin-key', required: true })
  create(@Body() dto: CreatePlanDto): Promise<PlanView> {
    return this.plans.create(dto);
  }
}
