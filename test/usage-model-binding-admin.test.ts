import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { updateAdminUsageModelBinding } from '../src/modules/ai/usage-model-binding.js';

describe('usage model binding administration', () => {
  it('stores canonicalModelId and writes an admin audit record', async () => {
    const upsert = vi.fn(async ({ create }: { create: { key: string; canonicalModelId: string; fixedCredits: string } }) => ({
      ...create,
      fixedCredits: new Prisma.Decimal(create.fixedCredits),
      updatedAt: new Date('2026-09-14T00:00:00.000Z'),
    }));
    const createOperation = vi.fn(async () => ({}));
    const model = {
      id: 'canonical-chat-a',
      canonicalModelKey: 'chat-a',
      displayName: 'Chat A',
      modality: 'chat',
      enabled: true,
      status: 'PUBLISHED',
      capabilities: {},
      defaultRouteId: 'route-a',
      routes: [{
        id: 'route-a',
        canonicalModelId: 'canonical-chat-a',
        channelId: 'channel-a',
        upstreamModelId: 'vendor-chat-a',
        enabled: true,
        upstreamAvailable: true,
        healthStatus: 'HEALTHY',
        capabilitiesOverride: null,
        channel: { status: 'ACTIVE', capabilities: ['LLM'] },
      }],
    };
    const transaction = {
      aiModel: { findUnique: vi.fn(async () => model) },
      aiUsageModelBinding: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
      adminOperation: { create: createOperation },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaClient;

    await expect(updateAdminUsageModelBinding(
      prisma,
      'CANVAS_TEXT',
      { canonicalModelId: 'canonical-chat-a', fixedCredits: '1.5' },
      { actor: 'test-admin', requestId: 'request-1' },
    )).resolves.toMatchObject({
      key: 'CANVAS_TEXT',
      canonicalModelId: 'canonical-chat-a',
      fixedCredits: '1.500000',
      canonicalModelKey: 'chat-a',
      operational: true,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { key: 'CANVAS_TEXT', canonicalModelId: 'canonical-chat-a', fixedCredits: '1.5' },
      update: { canonicalModelId: 'canonical-chat-a', fixedCredits: '1.5' },
    }));
    expect(createOperation).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'USAGE_MODEL_BINDING_UPDATED' }),
    }));
  });
});
