import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  UsageModelBindingError,
  ensureDefaultUsageModelBindings,
  resolveUsageModelBinding,
  routeSupportsUsage,
} from '../src/modules/ai/usage-model-binding.js';

const channel = (id: string, capabilities: string[]) => ({
  id,
  name: id,
  status: 'ACTIVE',
  capabilities,
});

const route = (id: string, channelId: string, capabilities: string[] = ['LLM']) => ({
  id,
  canonicalModelId: 'model-a',
  channelId,
  upstreamModelId: `${id}-upstream`,
  enabled: true,
  upstreamAvailable: true,
  healthStatus: 'HEALTHY',
  capabilitiesOverride: null,
  metadata: null,
  channel: channel(channelId, capabilities),
});

describe('usage model binding routing', () => {
  it('bootstraps bindings only from enabled, published models with eligible routes', async () => {
    const create = vi.fn(async () => ({}));
    const disabledPreferred = {
      id: 'model-disabled',
      canonicalModelKey: 'gpt-5.6-sol',
      modality: 'chat',
      enabled: false,
      status: 'PUBLISHED',
      capabilities: { supportsVision: true },
      defaultRouteId: null,
      routes: [route('route-disabled-model', 'channel-disabled-model', ['VISION'])],
    };
    const eligible = {
      id: 'model-eligible',
      canonicalModelKey: 'chat-eligible',
      modality: 'chat',
      enabled: true,
      status: 'PUBLISHED',
      capabilities: { supportsVision: true },
      defaultRouteId: null,
      routes: [route('route-eligible', 'channel-eligible', ['LLM'])],
    };
    const transaction = {
      aiModel: { findMany: vi.fn(async () => [disabledPreferred, eligible]) },
      aiUsageModelBinding: {
        findUnique: vi.fn(async () => null),
        create,
      },
    };

    await ensureDefaultUsageModelBindings(transaction as never);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map(([call]) => call.data)).toEqual([
      { key: 'IMAGE_ANALYSIS', canonicalModelId: 'model-eligible', fixedCredits: '1.000000' },
      { key: 'CANVAS_TEXT', canonicalModelId: 'model-eligible', fixedCredits: '1.000000' },
    ]);
  });

  it('keeps canvas text and prompt optimization inside the bound canonical model routes', async () => {
    const routes = [route('route-a1', 'channel-a1'), route('route-a2', 'channel-a2')];
    const prisma = {
      aiUsageModelBinding: {
        findUnique: vi.fn(async () => ({
          key: 'CANVAS_TEXT',
          canonicalModelId: 'model-a',
          updatedAt: new Date(),
          canonicalModel: {
            id: 'model-a',
            canonicalModelKey: 'chat-a',
            displayName: 'Chat A',
            modality: 'chat',
            enabled: true,
            status: 'PUBLISHED',
            capabilities: {},
            defaultRouteId: 'route-a1',
            routes,
          },
        })),
      },
    } as unknown as PrismaClient;

    const resolved = await resolveUsageModelBinding(prisma, 'CANVAS_TEXT');
    expect(resolved.model.canonicalModelKey).toBe('chat-a');
    expect(resolved.enabledRoutes.map((item) => item.id)).toEqual(['route-a1', 'route-a2']);
    expect(resolved.enabledRoutes.every((item) => item.canonicalModelId === 'model-a')).toBe(true);
  });

  it('requires a vision-capable operational route for image analysis', async () => {
    const prisma = {
      aiUsageModelBinding: {
        findUnique: vi.fn(async () => ({
          key: 'IMAGE_ANALYSIS',
          canonicalModelId: 'model-a',
          updatedAt: new Date(),
          canonicalModel: {
            id: 'model-a',
            canonicalModelKey: 'chat-a',
            displayName: 'Chat A',
            modality: 'chat',
            enabled: true,
            status: 'PUBLISHED',
            capabilities: {},
            defaultRouteId: null,
            routes: [route('route-a1', 'channel-a1')],
          },
        })),
      },
    } as unknown as PrismaClient;

    await expect(resolveUsageModelBinding(prisma, 'IMAGE_ANALYSIS'))
      .rejects.toMatchObject<UsageModelBindingError>({ code: 'USAGE_MODEL_NOT_AVAILABLE' });
  });

  it('accepts explicit Vision channels or supportsVision capability without widening channel enums', () => {
    expect(routeSupportsUsage(
      'IMAGE_ANALYSIS',
      {},
      route('route-vision', 'channel-vision', ['VISION']),
    )).toBe(true);
    expect(routeSupportsUsage(
      'IMAGE_ANALYSIS',
      { supportsVision: true },
      route('route-generic', 'channel-generic', ['LLM']),
    )).toBe(true);
    expect(routeSupportsUsage(
      'IMAGE_ANALYSIS',
      {},
      route('route-generic', 'channel-generic', ['LLM']),
    )).toBe(false);
    expect(routeSupportsUsage('CANVAS_TEXT', {}, {
      ...route('route-missing-channel', 'missing-channel'),
      channel: null,
    })).toBe(false);
  });
});
