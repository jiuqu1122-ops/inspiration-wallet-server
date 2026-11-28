import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { updateAdminUsageModelBinding } from '../src/modules/ai/usage-model-binding.js';

describe('usage model binding administration', () => {
  it.each([
    { key: 'CANVAS_TEXT', input: '1.5', expected: '1.500000' },
    { key: 'WEB_SEARCH', input: '0', expected: '0.000000' },
    { key: 'WEB_SEARCH', input: null, expected: null },
  ] as const)('stores $key binding with $input credits and writes an admin audit record', async ({ key, input, expected }) => {
    const upsert = vi.fn(async ({ create }: { create: { key: string; canonicalModelId: string; fixedCredits: string | null } }) => ({
      ...create,
      fixedCredits: create.fixedCredits === null ? null : new Prisma.Decimal(create.fixedCredits),
      updatedAt: new Date('2026-09-14T00:00:00.000Z'),
    }));
    const createOperation = vi.fn(async () => ({}));
    const model = {
      id: 'canonical-chat-a',
      canonicalModelKey: 'chat-a',
      displayName: 'Chat A',
      modality: 'chat',
      billingType: 'token',
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
      key,
      { canonicalModelId: 'canonical-chat-a', fixedCredits: input },
      { actor: 'test-admin', requestId: 'request-1' },
    )).resolves.toMatchObject({
      key,
      canonicalModelId: 'canonical-chat-a',
      fixedCredits: expected,
      canonicalModelKey: 'chat-a',
      operational: true,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { key, canonicalModelId: 'canonical-chat-a', fixedCredits: input },
      update: { canonicalModelId: 'canonical-chat-a', fixedCredits: input },
    }));
    expect(createOperation).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'USAGE_MODEL_BINDING_UPDATED' }),
    }));
  });
});
