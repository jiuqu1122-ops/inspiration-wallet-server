import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { recoverStaleAiRequests } from '../src/modules/ai/request-recovery.js';

function fixture(operations: Array<'imagine' | 'upscale'>, includeLegacy = false) {
  const operationRows = operations.map((operation, index) => ({
    id: `operation-${index}`, userId: 'owner', capability: 'IMAGE', clientRequestId: `operation-receipt-${index}`,
    estimatedCredits: new Prisma.Decimal('5'),
    pricingSnapshot: { schemaVersion: 1, modality: 'image', request: { operation, speed: 'fast', operationUnitCredits: '5.000000' } },
  }));
  const legacy = { id: 'legacy-image', userId: 'owner', capability: 'IMAGE', clientRequestId: 'legacy-image-receipt',
    estimatedCredits: new Prisma.Decimal('20'), pricingSnapshot: { schemaVersion: 1, modality: 'image', request: { count: 1 } } };
  const transaction = {
    aiRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    aiVideoTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
    wallet: { update: vi.fn(async () => ({ availableCredits: new Prisma.Decimal('100') })) },
    walletLedger: { create: vi.fn(async () => ({})) },
  };
  const rows = [...operationRows, ...(includeLegacy ? [legacy] : [])];
  const prisma = {
    aiRequest: { findMany: vi.fn(async ({ cursor, skip = 0, take }: { cursor?: { id: string }; skip?: number; take: number }) => {
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + skip : 0;
      return rows.slice(start, start + take);
    }) },
    $transaction: vi.fn(async (run: (value: typeof transaction) => Promise<unknown>) => run(transaction)),
  };
  return { prisma, transaction };
}

describe('stale image operation reservations', () => {
  it.each(['imagine', 'upscale'] as const)('holds a stale %s operation without relying on a persisted task journal', async operation => {
    const { prisma, transaction } = fixture([operation]);
    const result = await recoverStaleAiRequests(prisma as never, new Date('2026-10-01T00:00:00Z'));
    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(prisma.aiRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['RESERVED', 'PROCESSING'] } }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(transaction.aiRequest.updateMany).not.toHaveBeenCalled();
    expect(transaction.wallet.update).not.toHaveBeenCalled();
    expect(transaction.walletLedger.create).not.toHaveBeenCalled();
  });

  it('still releases legacy image reservations while leaving running or uncertain operation holds untouched', async () => {
    const { prisma, transaction } = fixture(['imagine', 'upscale'], true);
    const result = await recoverStaleAiRequests(prisma as never, new Date('2026-10-01T00:00:00Z'));
    expect(result).toEqual({ scanned: 3, recovered: 1 });
    expect(transaction.aiRequest.updateMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'legacy-image' }), data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(transaction.wallet.update).toHaveBeenCalledExactlyOnceWith({
      where: { userId: 'owner' },
      data: { availableCredits: { increment: new Prisma.Decimal('20') }, reservedCredits: { decrement: new Prisma.Decimal('20') } },
    });
    expect(transaction.walletLedger.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      data: expect.objectContaining({ requestId: 'legacy-image', type: 'RELEASE', amount: new Prisma.Decimal('20') }),
    }));
  });

  it('pages beyond a full batch of held operations to release a newer legacy reservation', async () => {
    const { prisma, transaction } = fixture(Array.from({ length: 100 }, () => 'imagine' as const), true);
    const result = await recoverStaleAiRequests(prisma as never, new Date('2026-10-01T00:00:00Z'));
    expect(result).toEqual({ scanned: 101, recovered: 1 });
    expect(prisma.aiRequest.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.aiRequest.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { id: 'operation-99' }, skip: 1, take: 100, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
    expect(transaction.aiRequest.updateMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'legacy-image' }),
    }));
    expect(transaction.walletLedger.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      data: expect.objectContaining({ requestId: 'legacy-image', type: 'RELEASE' }),
    }));
  });
});
