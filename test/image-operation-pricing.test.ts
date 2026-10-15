import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildClientPricingProjection, calculateSnapshotCharge, capturePricingSnapshot, catalogProfileToImagePrice,
  estimateSnapshotCredits, imagePriceToCatalogProfile, publishPendingPrice, setPendingPrice, validatePricingProfile, type CatalogPricingProfile } from '../src/modules/ai/pricing-center.js';
import { IMAGE_OPERATIONS, IMAGE_OPERATION_SPEEDS, quoteImageOperation } from '../src/modules/ai/image-operation-pricing.js';

const operations = ['imagine', 'blend', 'describe', 'shorten', 'uploads', 'upscale', 'upscale_creative', 'upscale_subtle', 'upscale_subtile',
  'variation', 'high_variation', 'low_variation', 'reroll', 'zoom', 'custom_zoom', 'pan', 'inpaint', 'modal'];
const matrix = { imagine: { fast: '20', relax: '10.5', turbo: '40' }, upscale_subtle: { fast: '3' }, upscale_subtile: { fast: '0' }, modal: { fast: '2' } };
const profile: CatalogPricingProfile = { billingType: 'image_flat', creditsPerRequest: '99', creditsPerOperation: matrix };
const model = { id: 'operation-model', canonicalModelKey: 'operation-image', modality: 'image', billingType: 'image_flat' };

function pricingDatabase(pricing: unknown = structuredClone(profile), membershipPrices?: unknown) {
  const version = { id: 'price-1', version: 1, publishedAt: new Date(0), pricing };
  const membership = membershipPrices === undefined ? null : { id: 'membership', planId: 'plan', plan: { versions: [{ id: 'plan-version', prices: membershipPrices }] } };
  const db = { aiModelPricing: { findUnique: vi.fn(async () => ({ currentVersion: version })) },
    userMembership: { findFirst: vi.fn(async () => membership) } } as unknown as PrismaClient;
  return { db, version };
}

describe('optional image operation pricing validation', () => {
  it('exports the exact documented operation and speed identities without merging the two subtle spellings', () => {
    expect(IMAGE_OPERATIONS).toEqual(operations);
    expect(IMAGE_OPERATION_SPEEDS).toEqual(['fast', 'relax', 'turbo']);
  });

  it('accepts all eighteen operations as independent configured prices with explicit zero', () => {
    const full = Object.fromEntries(operations.map((operation, index) => [operation, { fast: String(index), relax: '0', turbo: '0.000001' }]));
    expect(validatePricingProfile('image', { ...profile, creditsPerOperation: full }).creditsPerOperation).toEqual(full);
  });

  it.each([null, [], '20', { unknown: { fast: '1' } }, { imagine: null }, { imagine: [] }, { imagine: { normal: '1' } },
    { imagine: { fast: 0 } }, { imagine: { fast: '-1' } }, { imagine: { fast: '1e3' } }, { imagine: { fast: '1.0000001' } },
    { imagine: { fast: '01' } }, { imagine: { fast: ' 1 ' } }, { imagine: { fast: '10000000000000000' } },
    JSON.parse('{"__proto__":{"fast":"1"}}')])('rejects malformed operation pricing before publication %#', creditsPerOperation => {
    expect(() => validatePricingProfile('image', { ...profile, creditsPerOperation })).toThrow();
  });

  it.each([
    ['image', { billingType: 'image_count', creditsPerImage: '1' }],
    ['image', { billingType: 'image_resolution', creditsPerImageByResolution: { '2k': '1' } }],
    ['audio', { billingType: 'music_flat', creditsPerRequest: '1' }],
    ['chat', { billingType: 'request', creditsPerRequest: '1' }],
  ] as const)('rejects image operation prices attached to unrelated %s billing', (modality, unrelatedProfile) => {
    expect(() => validatePricingProfile(modality, { ...unrelatedProfile, creditsPerOperation: matrix })).toThrow();
  });

  it('quotes only the exact operation and speed and preserves six-decimal precision without floating point', () => {
    const published = { ...profile, creditsPerOperation: { imagine: { fast: '9999999999999999.999999', relax: '0.000001' } } };
    expect(quoteImageOperation(published, { operation: 'imagine', speed: 'fast' })).toEqual({ operation: 'imagine', speed: 'fast', credits: '9999999999999999.999999' });
    expect(quoteImageOperation(published, { operation: 'imagine', speed: 'relax' }).credits).toBe('0.000001');
    expect(() => quoteImageOperation(published, { operation: 'Imagine', speed: 'fast' })).toThrow();
    expect(() => quoteImageOperation(published, { operation: 'imagine', speed: 'FAST' })).toThrow();
  });
});

describe('operation price capture and settlement', () => {
  it.each([0, 1, 4])('locks the selected price and charges once when the operation returns %i images', async generatedCount => {
    const { db, version } = pricingDatabase();
    const snapshot = await capturePricingSnapshot(db, model, 'route', { operation: 'imagine', speed: 'fast', count: 4, operationUnitCredits: '0' });
    expect(snapshot.request).toMatchObject({ operation: 'imagine', speed: 'fast', operationUnitCredits: '20.000000' });
    version.pricing = { ...profile, creditsPerOperation: { imagine: { fast: '900' } } };
    expect(estimateSnapshotCredits(snapshot)).toBe('20.000000');
    expect(calculateSnapshotCharge(snapshot, { generatedCount })).toMatchObject({ quantity: '1', totalCredits: '20.000000',
      details: { operation: 'imagine', speed: 'fast', operationUnitCredits: '20.000000' } });
  });

  it('keeps the documented subtle and subtile operations distinct and allows an explicitly free task', async () => {
    const { db } = pricingDatabase();
    const subtle = await capturePricingSnapshot(db, model, 'route', { operation: 'upscale_subtle', speed: 'fast' });
    const subtile = await capturePricingSnapshot(db, model, 'route', { operation: 'upscale_subtile', speed: 'fast' });
    expect(calculateSnapshotCharge(subtle).totalCredits).toBe('3.000000');
    expect(estimateSnapshotCredits(subtile)).toBe('0.000000');
    expect(calculateSnapshotCharge(subtile, { generatedCount: 0 })).toMatchObject({ quantity: '1', totalCredits: '0.000000' });
  });

  it('charges a text or modal operation independently of image count', async () => {
    const { db } = pricingDatabase();
    const captured = await capturePricingSnapshot(db, model, 'route', { operation: 'modal', speed: 'fast', count: 1 });
    expect(calculateSnapshotCharge(captured, { generatedCount: 0 })).toMatchObject({ quantity: '1', totalCredits: '2.000000' });
  });

  it.each([{ operation: 'pan', speed: 'fast' }, { operation: 'imagine', speed: 'missing' }, { operation: 'imagine', speed: 'turbo-missing' },
    { operation: 'modal', speed: 'relax' }, { operation: 'imagine' }, { speed: 'fast' }])('never falls back to the base flat price for an unpriced operation %#', async request => {
    const { db } = pricingDatabase();
    await expect(capturePricingSnapshot(db, model, 'route', request)).rejects.toMatchObject({ code: 'PRICING_NOT_AVAILABLE' });
  });

  it('rejects an advanced operation when the model has only the legacy flat price', async () => {
    const { db } = pricingDatabase({ billingType: 'image_flat', creditsPerRequest: '99' });
    await expect(capturePricingSnapshot(db, model, 'route', { operation: 'imagine', speed: 'fast' })).rejects.toMatchObject({ code: 'PRICING_NOT_AVAILABLE' });
  });

  it.each([false, true])('preserves ordinary flat generation without an operation request, matrix configured=%s', async configured => {
    const ordinary = { billingType: 'image_flat', creditsPerRequest: '99' };
    const { db } = pricingDatabase(configured ? profile : ordinary);
    const snapshot = await capturePricingSnapshot(db, model, 'route', { count: 4 });
    expect(snapshot.request).toEqual({ count: 4 });
    expect(calculateSnapshotCharge(snapshot, { generatedCount: 0 }).totalCredits).toBe('99.000000');
    expect(calculateSnapshotCharge(snapshot, { generatedCount: 4 }).quantity).toBe('1');
    if (!configured) expect(snapshot.pricing).toEqual(ordinary);
  });

  it('retains the operation matrix when a membership only overrides the legacy flat price and applies its discount before locking', async () => {
    const { db } = pricingDatabase(structuredClone(profile), { models: { 'operation-image': { billingType: 'image_flat', creditsPerRequest: '55' } }, discounts: { other: '5' } });
    const snapshot = await capturePricingSnapshot(db, model, 'route', { operation: 'imagine', speed: 'fast' }, 'owner');
    expect(snapshot.request.operationUnitCredits).toBe('10.000000');
    expect(calculateSnapshotCharge(snapshot).totalCredits).toBe('10.000000');
    expect(snapshot).toMatchObject({ membershipId: 'membership', membershipPlanId: 'plan', membershipPlanVersionId: 'plan-version' });
  });

  it('uses an explicit membership operation matrix override, including free operations', async () => {
    const { db } = pricingDatabase(structuredClone(profile), { models: { 'operation-image': { creditsPerOperation: { imagine: { fast: '0' } } } } });
    const snapshot = await capturePricingSnapshot(db, model, 'route', { operation: 'imagine', speed: 'fast' }, 'owner');
    expect(snapshot.request.operationUnitCredits).toBe('0.000000');
    expect(calculateSnapshotCharge(snapshot, { generatedCount: 4 }).totalCredits).toBe('0.000000');
  });

  it.each([undefined, 'invalid', '-1', '0.0000001', 0])('does not re-quote or fall back when a saved operation has an invalid locked unit %#', async operationUnitCredits => {
    const { db } = pricingDatabase();
    const snapshot = await capturePricingSnapshot(db, model, 'route', { operation: 'imagine', speed: 'fast' });
    expect(() => calculateSnapshotCharge({ ...snapshot, request: { ...snapshot.request, operationUnitCredits } }))
      .toThrow(expect.objectContaining({ code: 'PRICING_NOT_AVAILABLE' }));
  });
});

describe('client operation price projection', () => {
  const projectionRoute = (id: string, speed: string, overrides: Record<string, unknown> = {}) => ({
    id, priority: 0, enabled: true, upstreamAvailable: true, healthStatus: 'HEALTHY', channel: { status: 'ACTIVE' },
    adapterKey: 'GENERIC_OPENAI_IMAGE', executionMode: 'TASK', executionConfig: { profile: 'GENERIC_TASK' },
    adapterConfig: { enableTaskOperations: true, requestParameters: { operation: 'imagine', speed, n: 1 } }, ...overrides,
  });
  const projectionDatabase = (routes: ReturnType<typeof projectionRoute>[], defaultRouteId?: string, pricing: unknown = structuredClone(profile)) => {
    const published = { ...model, defaultRouteId, routes, pricing: { currentVersion: { pricing, publishedAt: new Date(0) } } };
    const findMany = vi.fn(async () => [published]);
    const db = { aiModel: { findMany }, aiUsageModelBinding: { findMany: vi.fn(async () => []) } } as unknown as PrismaClient;
    return { db, published, findMany };
  };

  it.each([['fast', '20.000000'], ['turbo', '40.000000'], ['relax', '10.500000']])('projects the configured default imagine/%s quote for existing desktop clients', async (speed, credits) => {
    const state = projectionDatabase([projectionRoute('first', 'fast'), projectionRoute('default', speed!)], 'default');
    const result = await buildClientPricingProjection(state.db);
    expect(result.imageModels).toEqual([expect.objectContaining({ creditsPerRequest: credits, credits1k: credits, credits2k: credits, credits4k: credits, creditsPerOperation: matrix })]);
    expect(state.published.pricing.currentVersion.pricing).toEqual(profile);
    expect(state.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ routes: {
      include: { channel: { select: { status: true } } }, orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    } }) }));
  });

  it('uses the first available ordered route when the configured default cannot receive traffic', async () => {
    const state = projectionDatabase([projectionRoute('inactive', 'fast', { channel: { status: 'DISABLED' } }),
      projectionRoute('fallback', 'turbo'), projectionRoute('last', 'relax')], 'inactive');
    expect((await buildClientPricingProjection(state.db)).imageModels[0]?.creditsPerRequest).toBe('40.000000');
  });

  it('omits a configured operation model with no available route instead of falling back to its base price', async () => {
    const state = projectionDatabase([projectionRoute('disabled', 'turbo', { enabled: false })], 'disabled');
    expect((await buildClientPricingProjection(state.db)).imageModels).toEqual([]);
  });

  it.each(['missing-price', 'missing-speed', 'invalid-operation', 'invalid-profile'] as const)('omits an operational default with %s instead of advertising the legacy base price', async kind => {
    const route = projectionRoute('default', kind === 'missing-price' ? 'turbo' : 'fast');
    if (kind === 'missing-speed') delete (route.adapterConfig.requestParameters as Record<string, unknown>).speed;
    if (kind === 'invalid-operation') route.adapterConfig.requestParameters.operation = 'upscale';
    if (kind === 'invalid-profile') route.executionConfig.profile = 'USELG_IMAGE_TASK';
    const pricing = kind === 'missing-price' ? { ...profile, creditsPerOperation: { imagine: { fast: '20' } } } : profile;
    expect((await buildClientPricingProjection(projectionDatabase([route], 'default', pricing).db)).imageModels).toEqual([]);
  });

  it.each(['plain', 'other-adapter', 'direct', 'ordinary-default', 'unconfigured'] as const)('preserves the existing legacy flat price for %s routes', async kind => {
    const route = projectionRoute('default', 'turbo');
    if (kind === 'plain' || kind === 'ordinary-default') route.adapterConfig = {} as typeof route.adapterConfig;
    if (kind === 'other-adapter') route.adapterKey = 'SEEDREAM_IMAGE';
    if (kind === 'direct') route.executionMode = 'DIRECT';
    const routes = kind === 'unconfigured' ? [] : kind === 'ordinary-default' ? [projectionRoute('operations', 'turbo'), route] : [route];
    const result = await buildClientPricingProjection(projectionDatabase(routes, 'default').db);
    expect(result.imageModels[0]).toMatchObject({ creditsPerRequest: '99', credits1k: '99', credits2k: '99', credits4k: '99', creditsPerOperation: matrix });
  });

  it('preserves an explicitly free configured default operation price', async () => {
    const state = projectionDatabase([projectionRoute('default', 'turbo')], 'default', { ...profile, creditsPerOperation: { imagine: { turbo: '0' } } });
    expect((await buildClientPricingProjection(state.db)).imageModels[0]?.creditsPerRequest).toBe('0.000000');
  });

  it('round-trips operation prices without injecting the optional field on old image prices', () => {
    const client = catalogProfileToImagePrice('operation-image', profile)!;
    expect(client).toMatchObject({ billingType: 'image_flat', creditsPerOperation: matrix });
    expect(imagePriceToCatalogProfile(client)).toEqual(profile);
    expect(catalogProfileToImagePrice('ordinary', { billingType: 'image_flat', creditsPerRequest: '99' })).not.toHaveProperty('creditsPerOperation');
  });

  it('includes the matrix in the public desktop price projection', async () => {
    const db = { aiModel: { findMany: vi.fn(async () => [{ ...model, pricing: { currentVersion: { pricing: profile, publishedAt: new Date(0) } } }]) },
      aiUsageModelBinding: { findMany: vi.fn(async () => []) } } as unknown as PrismaClient;
    expect((await buildClientPricingProjection(db)).imageModels).toEqual([expect.objectContaining({ model: 'operation-image', creditsPerOperation: matrix })]);
  });

  it('preserves operation prices across the existing pending-price and immutable publish workflow', async () => {
    const upsert = vi.fn(async () => ({}));
    const create = vi.fn(async ({ data }: { data: { version: number; pricing: CatalogPricingProfile } }) => ({ id: 'published-2', ...data }));
    const tx = { aiModel: { findUnique: vi.fn(async () => ({ ...model, pricing: { pendingPrice: profile } })), update: vi.fn(async () => ({})) },
      aiModelPricing: { upsert, update: vi.fn(async () => ({})) }, aiPriceVersion: { aggregate: vi.fn(async () => ({ _max: { version: 1 } })), create } };
    const db = { ...tx, $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx) } as unknown as PrismaClient;
    await setPendingPrice(db, model.canonicalModelKey, profile);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ pendingPrice: profile }), update: { pendingPrice: profile } }));
    const published = await publishPendingPrice(db, model.canonicalModelKey, 'admin');
    expect(published).toEqual({ model: model.canonicalModelKey, version: 2, pricing: profile });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 2, pricing: profile, source: 'ADMIN_PUBLISH' }) }));
  });
});
