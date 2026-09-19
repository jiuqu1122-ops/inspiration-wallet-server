import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildRechargeSessionUrl,
  consumeRechargeSession,
  createRechargeSession,
  hashRechargeSessionToken,
} from './session.js';
import type { RechargeSessionError } from './session.js';

const token = 'a'.repeat(43);

describe('recharge session', () => {
  it('builds an opaque website URL without any account token', () => {
    const url = new URL(buildRechargeSessionUrl('https://www.unmind.art/recharge/', token));
    expect(url.origin).toBe('https://www.unmind.art');
    expect(url.searchParams.get('session')).toBe(token);
    expect(url.searchParams.has('accessToken')).toBe(false);
    expect(url.searchParams.has('refreshToken')).toBe(false);
  });

  it('stores only a hash and expires within the configured ten-minute window', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const transaction = {
      rechargeSession: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); },
      },
    };
    const prisma = {
      $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;
    const now = new Date('2026-09-19T08:00:00.000Z');

    const result = await createRechargeSession(prisma, {
      userId: 'user-1',
      pageUrl: 'https://www.unmind.art/recharge/',
      ttlMinutes: 10,
      now,
      token,
    });

    expect(writes[0]?.tokenHash).toBe(hashRechargeSessionToken(token));
    expect(writes[0]?.tokenHash).not.toBe(token);
    expect(writes[0]?.userId).toBe('user-1');
    expect(result.expiresAt).toBe('2026-09-19T08:10:00.000Z');
  });

  it('returns only the user bound to the claimed session', async () => {
    const transaction = {
      rechargeSession: {
        findUnique: async () => ({
          id: 'session-1',
          expiresAt: new Date('2026-09-19T08:10:00.000Z'),
          consumedAt: null,
          user: { email: 'user@example.com', displayName: 'User', wallet: { availableCredits: 42 } },
        }),
        updateMany: async () => ({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;

    const result = await consumeRechargeSession(prisma, {
      token,
      now: new Date('2026-09-19T08:01:00.000Z'),
    });

    expect(result.account).toEqual({
      email: 'user@example.com',
      displayName: 'User',
      availableCredits: '42',
    });
  });

  it('atomically rejects a replayed session', async () => {
    const transaction = {
      rechargeSession: {
        findUnique: async () => ({
          id: 'session-1',
          expiresAt: new Date('2026-09-19T08:10:00.000Z'),
          consumedAt: null,
          user: { email: 'user@example.com', displayName: 'User', wallet: { availableCredits: 12 } },
        }),
        updateMany: async () => ({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaClient;

    await expect(consumeRechargeSession(prisma, {
      token,
      now: new Date('2026-09-19T08:01:00.000Z'),
    })).rejects.toEqual(expect.objectContaining<Partial<RechargeSessionError>>({
      code: 'invalid_recharge_session',
    }));
  });
});
