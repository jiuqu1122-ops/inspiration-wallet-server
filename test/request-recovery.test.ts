import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { recoverStaleAiRequests } from '../src/modules/ai/request-recovery.js';

function makePrisma(claimCount = 1) {
  const transaction = {
    aiRequest: { updateMany: vi.fn().mockResolvedValue({ count: claimCount }) },
    aiVideoTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    wallet: {
      update: vi.fn().mockResolvedValue({ availableCredits: new Prisma.Decimal('900') }),
    },
    walletLedger: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    aiRequest: {
      findMany: vi.fn().mockResolvedValue([{
        id: 'request-1',
        userId: 'user-1',
        capability: 'VIDEO',
        estimatedCredits: new Prisma.Decimal('170'),
        pricingSnapshot: null,
        clientRequestId: 'client-1',
      }]),
    },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return { prisma, transaction };
}

describe('stale AI request recovery', () => {
  it('claims stale requests, fails active video tasks, and releases the reservation once', async () => {
    const { prisma, transaction } = makePrisma();
    const result = await recoverStaleAiRequests(
      prisma as never,
      new Date('2026-09-28T00:00:00.000Z'),
    );

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(transaction.aiRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'request-1', status: { in: ['RESERVED', 'PROCESSING'] } }),
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(transaction.aiVideoTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { requestId: 'request-1', status: { notIn: ['SUCCEEDED', 'FAILED'] } },
      data: expect.objectContaining({ status: 'FAILED', assetState: 'expired', videoAvailable: false }),
    }));
    expect(transaction.wallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: {
        availableCredits: { increment: new Prisma.Decimal('170') },
        reservedCredits: { decrement: new Prisma.Decimal('170') },
      },
    });
    expect(transaction.walletLedger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requestId: 'request-1',
        type: 'RELEASE',
        amount: new Prisma.Decimal('170'),
      }),
    }));
  });

  it('does not touch the wallet when another request path already claimed it', async () => {
    const { prisma, transaction } = makePrisma(0);
    const result = await recoverStaleAiRequests(
      prisma as never,
      new Date('2026-09-28T00:00:00.000Z'),
    );

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(transaction.wallet.update).not.toHaveBeenCalled();
    expect(transaction.walletLedger.create).not.toHaveBeenCalled();
    expect(transaction.aiVideoTask.updateMany).not.toHaveBeenCalled();
  });
});
