import request from 'supertest';
import { ADMIN_KEY, createTestApp, makePlan, resetDb, TestContext } from './harness';

describe('Plans (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const admin = (body: object) =>
    http().post('/admin/plans').set('x-admin-key', ADMIN_KEY).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDb(ctx.prisma));

  it('reports health with a live database check', async () => {
    await http().get('/health').expect(200, { status: 'ok' });
  });

  describe('GET /plans', () => {
    it('is empty when no plan exists', async () => {
      await http().get('/plans').expect(200, []);
    });

    it('lists active plans by price, each with a priced single-cycle option and its terms', async () => {
      await makePlan(ctx.prisma, { name: 'Premium', priceCents: 9900 });
      await makePlan(ctx.prisma, { name: 'Standard', priceCents: 4900 });
      await makePlan(ctx.prisma, { name: 'Retired', priceCents: 100, active: false });

      const { body } = await http().get('/plans').expect(200);

      expect(body.map((p: { name: string }) => p.name)).toEqual(['Standard', 'Premium']);
      expect(body[0].terms).toEqual([
        {
          cycles: 1,
          discountBps: 0,
          label: '4 weeks',
          grossCents: 4900,
          discountCents: 0,
          totalCents: 4900,
        },
        {
          cycles: 3,
          discountBps: 1000,
          label: '12 weeks',
          grossCents: 14_700,
          discountCents: 1470,
          totalCents: 13_230,
        },
        {
          cycles: 6,
          discountBps: 1500,
          label: '24 weeks',
          grossCents: 29_400,
          discountCents: 4410,
          totalCents: 24_990,
        },
      ]);
    });
  });

  describe('POST /admin/plans', () => {
    const valid = {
      name: 'Standard',
      priceCents: 4900,
      currency: 'usd',
      terms: [
        { cycles: 3, discountBps: 1000 },
        { cycles: 6, discountBps: 1500 },
      ],
    };

    it('rejects a missing or wrong admin key', async () => {
      await http().post('/admin/plans').send(valid).expect(401);
      await http()
        .post('/admin/plans')
        .set('x-admin-key', 'wrong-key-0123456789')
        .send(valid)
        .expect(401);
      expect(await ctx.prisma.plan.count()).toBe(0);
    });

    it('creates a plan with a default 28-day cycle and length-named terms', async () => {
      const { body } = await admin(valid).expect(201);
      expect(body).toMatchObject({
        name: 'Standard',
        cycleDays: 28,
        currency: 'usd',
        priceCents: 4900,
      });
      expect(body.terms.map((t: { label: string }) => t.label)).toEqual([
        '4 weeks',
        '12 weeks',
        '24 weeks',
      ]);
      expect(await ctx.prisma.planTerm.count()).toBe(2);
    });

    it('supports a custom cycle length and labels it by days when it is not whole weeks', async () => {
      const { body } = await admin({
        ...valid,
        name: 'Monthly-ish',
        cycleDays: 30,
        terms: [],
      }).expect(201);
      expect(body.cycleDays).toBe(30);
      expect(body.terms[0].label).toBe('30 days');
    });

    it('returns 409 for a duplicate name', async () => {
      await admin(valid).expect(201);
      await admin(valid).expect(409);
      expect(await ctx.prisma.plan.count()).toBe(1);
    });

    it.each([
      ['a discount above 100%', { terms: [{ cycles: 3, discountBps: 10_001 }] }],
      ['a negative discount', { terms: [{ cycles: 3, discountBps: -1 }] }],
      [
        'duplicate term lengths',
        {
          terms: [
            { cycles: 3, discountBps: 100 },
            { cycles: 3, discountBps: 200 },
          ],
        },
      ],
      ['a one-cycle term', { terms: [{ cycles: 1, discountBps: 100 }] }],
      ['a fractional price', { priceCents: 49.99 }],
      ['a negative price', { priceCents: -1 }],
      ['an uppercase currency', { currency: 'USD' }],
      ['a zero-day cycle', { cycleDays: 0 }],
      ['an unknown field', { surprise: true }],
      ['an empty name', { name: '' }],
    ])('rejects %s', async (_name, override) => {
      await admin({ ...valid, ...override }).expect(400);
      expect(await ctx.prisma.plan.count()).toBe(0);
    });
  });
});
