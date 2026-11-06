import { ConflictException } from '@nestjs/common';
import { FakeGateway } from '@billing/gateway';
import { Clock } from '../../src/common/clock';
import { AppConfig } from '../../src/config/env';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SubscriptionsService } from '../../src/subscriptions/subscriptions.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const subscription = {
  id: '00000000-0000-4000-8000-0000000000a1',
  customerId: 'c1',
  planId: 'p1',
  termCycles: 1,
  status: 'active',
  anchorAt: new Date('2025-12-14T00:00:00.000Z'),
  paidThroughAt: new Date('2026-01-11T00:00:00.000Z'),
  pendingStop: null,
  failureCount: 0,
  dueAt: null,
  nextRetryAt: null,
  version: 4,
  createdAt: NOW,
  plan: { name: 'Standard' },
};

function build(updateCount: number) {
  const updateMany = jest.fn().mockResolvedValue({ count: updateCount });
  const prisma = {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(subscription),
      updateMany,
    },
  } as unknown as PrismaService;
  const clock = { now: () => NOW } as Clock;
  const service = new SubscriptionsService(prisma, clock, new FakeGateway(), {} as AppConfig);
  return { service, updateMany };
}

describe('SubscriptionsService.stop optimistic locking', () => {
  it('writes only against the version it read and bumps it', async () => {
    const { service, updateMany } = build(1);
    await service.stop(subscription.id, 'cancel');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: subscription.id, version: 4 },
      data: { pendingStop: 'cancel', version: { increment: 1 } },
    });
  });

  it('returns a conflict when another request changed the row first', async () => {
    const { service } = build(0);
    await expect(service.stop(subscription.id, 'cancel')).rejects.toThrow(ConflictException);
  });
});
