import { PrismaClient } from '@prisma/client';
import { termLabel } from '@billing/domain';

const prisma = new PrismaClient();

const PLANS = [
  {
    name: 'Standard',
    priceCents: 4900,
    cycleDays: 28,
    terms: [
      { cycles: 3, discountBps: 1000 },
      { cycles: 6, discountBps: 1500 },
    ],
  },
  {
    name: 'Basic',
    priceCents: 2900,
    cycleDays: 28,
    terms: [{ cycles: 3, discountBps: 500 }],
  },
];

async function main(): Promise<void> {
  for (const { terms, ...plan } of PLANS) {
    const saved = await prisma.plan.upsert({
      where: { name: plan.name },
      update: { priceCents: plan.priceCents, cycleDays: plan.cycleDays },
      create: { ...plan, currency: 'usd' },
    });
    for (const term of terms) {
      const label = termLabel(term.cycles, plan.cycleDays);
      await prisma.planTerm.upsert({
        where: { planId_cycles: { planId: saved.id, cycles: term.cycles } },
        update: { discountBps: term.discountBps, label },
        create: { planId: saved.id, ...term, label },
      });
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
