import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { getAdminTodayUsage, getAdminUsage } from '../src/modules/admin/service.js';

describe('administrator daily AI usage statistics', () => {
  it('aggregates generated images and reported tokens by China Standard Time day', async () => {
    const findMany = vi.fn(async () => [{
      capability: 'IMAGE',
      logicalModel: 'nano-banana-2',
      chargeBreakdown: { quantity: '3' },
      canonicalModel: { canonicalModelKey: 'nano-banana-2', displayName: 'Nano Banana 2' },
      user: { id: 'user-a', email: 'a@example.com', displayName: 'A', status: 'ACTIVE' },
    }, {
      capability: 'LLM',
      logicalModel: 'claude-sonnet',
      chargeBreakdown: {
        details: {
          usage: {
            inputTokens: '100',
            cachedInputTokens: '20',
            cacheWriteTokens: '10',
            outputTokens: '40',
          },
        },
      },
      canonicalModel: null,
      user: { id: 'user-a', email: 'a@example.com', displayName: 'A', status: 'ACTIVE' },
    }, {
      capability: 'VISION',
      logicalModel: 'gemini-vision',
      chargeBreakdown: {
        usage: {
          inputTokens: '50',
          cachedInputTokens: '5',
          cacheWriteTokens: '0',
          outputTokens: '10',
        },
      },
      canonicalModel: null,
      user: { id: 'user-b', email: 'b@example.com', displayName: null, status: 'ACTIVE' },
    }, {
      capability: 'LLM',
      logicalModel: 'claude-sonnet',
      chargeBreakdown: { details: { usage: null } },
      canonicalModel: null,
      user: { id: 'user-a', email: 'a@example.com', displayName: 'A', status: 'ACTIVE' },
    }]);
    const prisma = { aiRequest: { findMany } } as unknown as PrismaClient;
    const now = new Date('2026-09-15T01:30:00.000Z');

    const result = await getAdminTodayUsage(prisma, now);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'SUCCEEDED',
        createdAt: {
          gte: new Date('2026-09-14T16:00:00.000Z'),
          lt: new Date('2026-09-15T16:00:00.000Z'),
        },
      }),
    }));
    expect(result).toMatchObject({
      date: '2026-09-15',
      timeZone: 'Asia/Shanghai',
      totals: {
        activeUsers: 2,
        imageRequests: 1,
        imageCount: '3',
        tokenRequests: 3,
        tokenRequestsWithUsage: 2,
        tokenRequestsWithoutUsage: 1,
        inputTokens: '150',
        cachedInputTokens: '25',
        cacheWriteTokens: '10',
        outputTokens: '50',
        totalTokens: '210',
        imageModels: [{
          key: 'nano-banana-2',
          displayName: 'Nano Banana 2',
          imageRequests: 1,
          imageCount: '3',
        }],
      },
    });
    expect(result.items[0]).toMatchObject({
      userId: 'user-a',
      imageCount: '3',
      imageModels: [{ key: 'nano-banana-2', imageCount: '3' }],
      totalTokens: '150',
      tokenRequestsWithoutUsage: 1,
    });
    expect(result.items[1]).toMatchObject({
      userId: 'user-b',
      imageCount: '0',
      totalTokens: '60',
    });
  });

  it('queries thirty China Standard Time calendar days including today', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { aiRequest: { findMany } } as unknown as PrismaClient;
    const now = new Date('2026-09-15T01:30:00.000Z');

    const result = await getAdminUsage(prisma, 30, now);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: {
          gte: new Date('2026-08-16T16:00:00.000Z'),
          lt: new Date('2026-09-15T16:00:00.000Z'),
        },
      }),
    }));
    expect(result).toMatchObject({
      date: '2026-09-15',
      days: 30,
      startDate: '2026-08-17',
      endDate: '2026-09-15',
      range: {
        start: '2026-08-16T16:00:00.000Z',
        end: '2026-09-15T16:00:00.000Z',
      },
    });
  });
});
