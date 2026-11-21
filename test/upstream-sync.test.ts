import type { AiProviderChannel, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import { effectiveDiscoveryModality } from '../src/modules/ai/discovery-modality.js';
import {
  inferSuggestedModality,
  syncUpstreamModels,
  upstreamAdapterFor,
} from '../src/modules/ai/upstream-sync.js';

const provider = (
  kind = 'USELG',
  capabilities = ['IMAGE', 'VIDEO'],
) => ({
  id: 'provider-uselg',
  name: 'USELG',
  kind,
  status: 'ACTIVE',
  priority: 10,
  baseUrl: 'https://8.8.8.8',
  defaultModel: null,
  allowInsecureHttp: false,
  encryptedSecrets: encryptProviderSecrets({ apiKey: 'sk-test', headers: {} }),
  apiKeyLast4: 'test',
  capabilities,
  paramOverrides: null,
  lastTestStatus: null,
  lastTestMessage: null,
  lastTestModelCount: null,
  lastTestedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}) as AiProviderChannel;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upstream model modality inference', () => {
  it('discovers Ark model domains and an explicitly configured image endpoint', async () => {
    const channel = { ...provider('VOLCENGINE_ARK', ['IMAGE']), baseUrl: 'https://8.8.8.8/api/v3',
      defaultModel: 'ep-fixture' };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ object: 'list', data: [
      { id: 'seedream-fixture', domain: 'ImageGeneration' },
      { id: 'text-fixture', domain: 'VLM' },
      { id: 'embedding-fixture', domain: 'Embedding' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const items = await upstreamAdapterFor(channel).listModels(channel);
    expect(items.map(item => [item.upstreamModelId, item.modality])).toEqual([
      ['seedream-fixture', 'image'], ['text-fixture', 'chat'], ['embedding-fixture', null], ['ep-fixture', 'image'],
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://8.8.8.8/api/v3/models');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1].headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(headers.has('x-goog-api-key')).toBe(false);
  });

  it('keeps the managed Ark layer route settings when its upstream model is synchronized again', async () => {
    const channel = { ...provider('VOLCENGINE_ARK', ['IMAGE']), baseUrl: 'https://8.8.8.8/api/v3' };
    const canvasLayers = { split: { enabled: true, adapter: 'volcengine-ark', endpoint: '/images/generations',
      maxMegapixels: 16, maxLayers: 10, creditsPerRequest: '12' } };
    const route = { id: 'ark-layer-route', canonicalModelId: 'seedream-model', upstreamAvailable: true,
      healthStatus: 'HEALTHY', costProfile: null, metadata: { canvasLayers } };
    const update = vi.fn();
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => channel) },
      aiModelRoute: { findFirst: vi.fn(async () => route), update },
    } as unknown as PrismaClient;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'seedream-fixture', domain: 'ImageGeneration' }] })));
    await expect(syncUpstreamModels(prisma, channel.id)).resolves.toMatchObject({ mapped: 1 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: expect.objectContaining({ canvasLayers }) }),
    }));
  });
  it.each([
    'sd2.0',
    'sd2.0-900-内置过脸',
    'sd2.0-933-内置过脸',
    'sd2.0-fast-900-卡真人',
    'sd2.0-fast-933-真人',
    'sd2.0-满血-933-真人',
    'sd2.5-10-卡真人',
    'sd-2-fast',
    'seedance-2.0',
    'seedance-2.5',
    'minimax_h3-768p',
  ])('recognizes the USELG alias %s as video', (upstreamModelId) => {
    expect(inferSuggestedModality(provider(), upstreamModelId, { id: upstreamModelId })).toBe('video');
  });

  it.each([
    'wan3.0-image',
    'sdxl',
    'sd3',
    'stable-diffusion-xl',
  ])('does not mistake the image model %s for a USELG video alias', (upstreamModelId) => {
    expect(inferSuggestedModality(provider(), upstreamModelId, { id: upstreamModelId })).toBe('image');
  });

  it('prefers explicit upstream type over a conflicting provider capability hint', () => {
    expect(inferSuggestedModality(
      provider('NEW_API', ['IMAGE']),
      'vendor-opaque-model',
      { id: 'vendor-opaque-model', type: 'video' },
    )).toBe('video');
  });

  it('recognizes supported explicit modality field names and values', () => {
    const imageProvider = provider('NEW_API', ['IMAGE']);
    expect(inferSuggestedModality(imageProvider, 'opaque-1', { model_type: 'text-to-image' })).toBe('image');
    expect(inferSuggestedModality(imageProvider, 'opaque-2', { modelType: 'video_generation' })).toBe('video');
    expect(inferSuggestedModality(imageProvider, 'opaque-3', { task_type: 'image-to-video' })).toBe('video');
    expect(inferSuggestedModality(imageProvider, 'opaque-4', { taskType: 'completion' })).toBe('chat');
    expect(inferSuggestedModality(imageProvider, 'opaque-5', { category: 'not-a-modality' })).toBe('image');
  });

  it('returns unknown when only ambiguous provider hints remain', () => {
    expect(inferSuggestedModality(
      provider('NEW_API', ['IMAGE', 'VIDEO']),
      'vendor-opaque-model',
      { id: 'vendor-opaque-model' },
    )).toBeNull();
  });

  it('uses a manual override as the effective modality', () => {
    expect(effectiveDiscoveryModality({
      modalityOverride: 'image',
      suggestedModality: 'video',
    })).toBe('image');
  });

  it('refreshes the automatic suggestion without overwriting a manual override', async () => {
    const channel = provider();
    const discovery = {
      id: 'discovery-uselg-sd2',
      status: 'UNMAPPED',
      modalityOverride: 'image',
      suggestedModality: 'image',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'sd2.0-fast-933-真人' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const discoveryUpsert = vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(discovery, update);
      return discovery;
    });
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => channel) },
      aiModelRoute: { findFirst: vi.fn(async () => null), create: vi.fn() },
      aiModel: { findUnique: vi.fn(async () => null) },
      aiModelAlias: { findUnique: vi.fn(async () => null) },
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        upsert: discoveryUpsert,
      },
    } as unknown as PrismaClient;

    await expect(syncUpstreamModels(prisma, channel.id)).resolves.toMatchObject({ unmapped: 1 });
    expect(discoveryUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ suggestedModality: 'video' }),
    }));
    expect(discoveryUpsert.mock.calls[0]?.[0].update).not.toHaveProperty('modalityOverride');
    expect(effectiveDiscoveryModality(discovery)).toBe('image');
  });

  it('reports a mapped route modality mismatch without moving the route', async () => {
    const channel = provider();
    const routeUpdate = vi.fn(async (input: unknown) => input);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'sd2.0-933-内置过脸' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const prisma = {
      aiProviderChannel: { findUnique: vi.fn(async () => channel) },
      aiModelRoute: {
        findFirst: vi.fn(async () => ({
          id: 'route-mapped-to-image',
          canonicalModelId: 'canonical-image',
          upstreamAvailable: true,
          healthStatus: 'HEALTHY',
          costProfile: null,
          metadata: null,
        })),
        update: routeUpdate,
      },
    } as unknown as PrismaClient;

    await expect(syncUpstreamModels(prisma, channel.id)).resolves.toMatchObject({ mapped: 1, unmapped: 0 });
    expect(routeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'route-mapped-to-image' },
      data: expect.objectContaining({
        metadata: expect.objectContaining({ inferredModality: 'video' }),
      }),
    }));
    for (const [call] of routeUpdate.mock.calls) {
      expect((call as { data: Record<string, unknown> }).data).not.toHaveProperty('canonicalModelId');
    }
  });
});
