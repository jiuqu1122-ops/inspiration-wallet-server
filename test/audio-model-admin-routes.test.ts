import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiModelAdminRoutes } from '../src/modules/ai/model-admin-routes.js';
import { aiRoutes } from '../src/modules/ai/routes.js';
import { getPublicAiCatalog, resolveCatalogModel } from '../src/modules/ai/model-catalog.js';
import { calculateSnapshotCharge, type PricingSnapshot } from '../src/modules/ai/pricing-center.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => {}) }));

describe('music model admin HTTP contract', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let model: any;
  let route: any;
  let pricing: any;
  let version: any;
  let discovery: any;

  beforeEach(async () => {
    model = null; route = null; pricing = null; version = null;
    discovery = { id: 'music-discovery', status: 'UNMAPPED', provider: 'USELG', channelId: 'channel', upstreamModelId: 'provider-audio', suggestedModality: 'image', modalityOverride: 'audio', availability: 'AVAILABLE', channel: { id: 'channel', kind: 'USELG', priority: 1, status: 'ACTIVE', encryptedSecrets: 'private-channel-secret' } };
    const fullModel = () => model ? { ...model, pricing: pricing ? { ...pricing, currentVersion: version } : null, routes: route ? [{ ...route, channel: discovery.channel }] : [], aliases: [] } : null;
    const fullRoute = () => route ? { ...route, canonicalModel: model, channel: discovery.channel } : null;
    const tx: any = {
      aiProviderChannel: { findMany: vi.fn(async () => []) },
      aiUsageModelBinding: { findMany: vi.fn(async () => []) },
      aiPricingConfig: { findUnique: vi.fn(async () => null) },
      aiUpstreamDiscovery: {
        findUnique: vi.fn(async () => discovery),
        updateMany: vi.fn(async ({ where, data }) => { if (discovery.status !== where.status) return { count: 0 }; Object.assign(discovery, data); return { count: 1 }; }),
      },
      aiModel: {
        findUnique: vi.fn(async () => fullModel()),
        findUniqueOrThrow: vi.fn(async () => fullModel()),
        findMany: vi.fn(async () => model?.status === 'PUBLISHED' && model.enabled && model.visible && version ? [fullModel()] : []),
        create: vi.fn(async ({ data }) => { model = { id: 'music-model', defaultRouteId: null, updatedAt: new Date(), ...data }; return model; }),
        update: vi.fn(async ({ data }) => { Object.assign(model, data); return fullModel(); }),
        updateMany: vi.fn(async ({ data }) => { Object.assign(model, data); return { count: 1 }; }),
      },
      aiModelRoute: {
        findMany: vi.fn(async () => route?.enabled && route.upstreamAvailable ? [fullRoute()] : []),
        upsert: vi.fn(async ({ create }) => { route = { id: 'music-route', updatedAt: new Date(), ...create }; return route; }),
        findUnique: vi.fn(async () => fullRoute()),
        findUniqueOrThrow: vi.fn(async () => fullRoute()),
        updateMany: vi.fn(async ({ data }) => { Object.assign(route, data); return { count: 1 }; }),
      },
      aiModelAlias: { findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }) => data) },
      aiModelPricing: {
        upsert: vi.fn(async ({ create, update }) => { pricing = { ...(pricing || create), ...(pricing ? update : {}), pricingMode: 'MANUAL' }; return pricing; }),
        update: vi.fn(async ({ data }) => { Object.assign(pricing, data); return pricing; }),
      },
      aiPriceVersion: {
        aggregate: vi.fn(async () => ({ _max: { version: version?.version ?? null } })),
        create: vi.fn(async ({ data }) => { version = { id: 'music-price', publishedAt: new Date(), ...data }; return version; }),
      },
      adminOperation: { create: vi.fn(async ({ data }) => data) },
    };
    prisma = { ...tx, $transaction: async (callback: (client: any) => unknown) => callback(tx) } as PrismaClient;
    app = Fastify();
    app.decorate('prisma', prisma);
    app.decorate('authenticateAccessToken', async () => {});
    await app.register(aiModelAdminRoutes, { prefix: '/v1/admin/ai-models' });
    await app.register(aiRoutes, { prefix: '/v1/ai' });
  });
  afterEach(() => app.close());

  const requestBody = { canonicalModelKey: 'configured-music', displayName: '音乐模型', modality: 'audio', billingType: 'music_flat', capabilities: { outputAssetType: 'audio', billingMode: 'per_request' }, visible: false, enabled: false };
  const createUrl = '/v1/admin/ai-models/unmapped/music-discovery/create';

  it('accepts the music draft sent by AI CENTER, maps it and publishes its flat price', async () => {
    const created = await app.inject({ method: 'POST', url: createUrl, payload: requestBody });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ modality: 'audio', billingType: 'music_flat', status: 'DRAFT', enabled: false, visible: false });
    expect(discovery).toMatchObject({ status: 'MAPPED', suggestedModelId: 'music-model' });
    expect(route).toMatchObject({ canonicalModelId: 'music-model', upstreamModelId: 'provider-audio', enabled: false });
    const base = '/v1/admin/ai-models/configured-music';
    const saved = await app.inject({ method: 'PUT', url: `${base}/pricing/pending`, payload: { billingType: 'music_flat', creditsPerRequest: '17' } });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await app.inject({ method: 'POST', url: `${base}/pricing/publish` });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ model: 'configured-music', version: 1, pricing: { billingType: 'music_flat', creditsPerRequest: '17' } });
    const enabled = await app.inject({ method: 'PATCH', url: base, payload: { status: 'PUBLISHED', enabled: true, visible: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const enabledRoute = await app.inject({ method: 'PATCH', url: '/v1/admin/ai-models/routes/music-route', payload: { enabled: true } });
    expect(enabledRoute.statusCode, enabledRoute.body).toBe(200);
    expect(await resolveCatalogModel(prisma, 'configured-music', 'audio')).toMatchObject({ model: { billingType: 'music_flat' }, route: { id: 'music-route', enabled: true } });
    const catalog = await getPublicAiCatalog(prisma);
    expect(catalog.models).toEqual([expect.objectContaining({ id: 'configured-music', modality: 'audio', billingType: 'music_flat', pricing: { billingType: 'music_flat', creditsPerRequest: '17' } })]);
    // This compatibility endpoint is the actual desktop transport, including
    // installations with no image or video provider at all.
    const desktop = await app.inject({ method: 'GET', url: '/v1/ai/images/models' });
    expect(desktop.statusCode, desktop.body).toBe(200);
    expect(desktop.json()).toMatchObject({ provider: 'NEW_API', models: [], channels: [], videoChannels: [], catalog: [{ id: 'configured-music', modality: 'audio', enabled: true, visible: true, isDefault: true, capabilities: { outputAssetType: 'audio', billingMode: 'per_request' } }] });
    expect(desktop.body).not.toContain('private-channel-secret');
    expect(desktop.body).not.toContain('provider-audio');
    model.visible = false;
    const hidden = await app.inject({ method: 'GET', url: '/v1/ai/images/models' });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json().catalog).toEqual([]);
    model.visible = true;
    for (const patch of [{ enabled: false }, { upstreamAvailable: false }, { healthStatus: 'UNHEALTHY' }]) {
      const savedRoute = { ...route };
      Object.assign(route, patch);
      const unavailable = await app.inject({ method: 'GET', url: '/v1/ai/images/models' });
      expect(unavailable.statusCode, unavailable.body).toBe(503);
      Object.assign(route, savedRoute);
    }
    discovery.channel.status = 'DISABLED';
    const inactive = await app.inject({ method: 'GET', url: '/v1/ai/images/models' });
    expect(inactive.statusCode, inactive.body).toBe(503);
    discovery.channel.status = 'ACTIVE';
    const snapshot: PricingSnapshot = { schemaVersion: 1, canonicalModelId: model.id, canonicalModelKey: model.canonicalModelKey, modality: 'audio', routeId: route.id, priceVersionId: version.id, priceVersion: 1, billingType: 'music_flat', pricing: version.pricing, request: {}, capturedAt: '' };
    expect(calculateSnapshotCharge(snapshot, { generatedCount: 4 })).toMatchObject({ totalCredits: '17.000000', quantity: '1' });
  });

  it('also accepts a music draft with its initial pending price', async () => {
    const response = await app.inject({ method: 'POST', url: createUrl, payload: { ...requestBody, pendingPrice: { billingType: 'music_flat', creditsPerRequest: '12' } } });
    expect(response.statusCode, response.body).toBe(200);
    expect(pricing.pendingPrice).toEqual({ billingType: 'music_flat', creditsPerRequest: '12' });
  });

  it.each([
    ['chat', 'token'], ['chat', 'request'],
    ['image', 'image_resolution'], ['image', 'image_flat'], ['image', 'image_count'],
    ['video', 'video_second'], ['video', 'video_flat'], ['video', 'video_duration'], ['video', 'video_resolution_duration'],
  ])('preserves creation for %s / %s', async (modality, billingType) => {
    discovery.modalityOverride = modality;
    const response = await app.inject({ method: 'POST', url: createUrl, payload: { ...requestBody, modality, billingType, capabilities: {} } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ modality, billingType, status: 'DRAFT' });
  });

  it('names an invalid field and performs no model writes for an unsupported billing type', async () => {
    const response = await app.inject({ method: 'POST', url: createUrl, payload: { ...requestBody, billingType: 'unsupported-private-value' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'Canonical model data is invalid: billingType' });
    expect(response.body).not.toContain('unsupported-private-value');
    expect(model).toBeNull(); expect(route).toBeNull();
  });

  it('continues rejecting a music creation against a discovery of another effective modality', async () => {
    discovery.modalityOverride = 'image';
    const response = await app.inject({ method: 'POST', url: createUrl, payload: requestBody });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('Discovery modality does not match');
    expect(model).toBeNull();
  });
});
