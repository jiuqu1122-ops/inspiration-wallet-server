import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { walletRoutes } from '../src/modules/wallets/routes.js';

describe('wallet usage route', () => {
  it('returns final non-zero credit usage and requests at most fifty entries', async () => {
    const findMany = vi.fn(async () => ([
      {
        id: 'ledger-1',
        requestId: 'request-1',
        type: 'CHARGE',
        amount: 16n,
        balanceAfter: 84n,
        description: '生图结算 1 张',
        createdAt: new Date('2026-08-27T10:00:00.000Z'),
      },
    ]));
    const app = Fastify();
    app.decorate('prisma', { walletLedger: { findMany } } as never);
    app.decorate('authenticateAccessToken', async (request: { user?: unknown }) => {
      request.user = { sub: 'user-1' };
    });
    await app.register(walletRoutes, { prefix: '/v1/wallet' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/wallet/usage?limit=50',
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: 'user-1',
        type: 'CHARGE',
        amount: { not: 0 },
      },
      take: 51,
    }));
    expect(response.json()).toEqual({
      items: [{
        id: 'ledger-1',
        requestId: 'request-1',
        type: 'CHARGE',
        amount: '16.000000',
        balanceAfter: '84.000000',
        description: '生图结算 1 张',
        createdAt: '2026-08-27T10:00:00.000Z',
      }],
      nextCursor: null,
    });
    await app.close();
  });
});
