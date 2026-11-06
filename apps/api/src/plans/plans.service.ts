import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Plan, PlanTerm, Prisma } from '@prisma/client';
import { priceTerm, termLabel } from '@billing/domain';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto, PlanView } from './plans.dto';

type PlanWithTerms = Plan & { terms: PlanTerm[] };

export function toPlanView(plan: PlanWithTerms): PlanView {
  const options = [
    { cycles: 1, discountBps: 0 },
    ...[...plan.terms].sort((a, b) => a.cycles - b.cycles),
  ];
  return {
    id: plan.id,
    name: plan.name,
    currency: plan.currency,
    priceCents: plan.priceCents,
    cycleDays: plan.cycleDays,
    terms: options.map(({ cycles, discountBps }) => ({
      cycles,
      discountBps,
      label: termLabel(cycles, plan.cycleDays),
      ...priceTerm({ priceCents: plan.priceCents, cycles, discountBps }),
    })),
  };
}

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      include: { terms: true },
      orderBy: { priceCents: 'asc' },
    });
    return plans.map(toPlanView);
  }

  async create(dto: CreatePlanDto): Promise<PlanView> {
    const cycleDays = dto.cycleDays ?? 28;
    const terms = dto.terms ?? [];
    if (new Set(terms.map((t) => t.cycles)).size !== terms.length) {
      throw new BadRequestException('Each term must have a different number of cycles');
    }

    try {
      const plan = await this.prisma.plan.create({
        data: {
          name: dto.name,
          priceCents: dto.priceCents,
          currency: dto.currency,
          cycleDays,
          terms: {
            create: terms.map((t) => ({
              cycles: t.cycles,
              discountBps: t.discountBps,
              label: termLabel(t.cycles, cycleDays),
            })),
          },
        },
        include: { terms: true },
      });
      return toPlanView(plan);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A plan named "${dto.name}" already exists`);
      }
      throw error;
    }
  }
}
