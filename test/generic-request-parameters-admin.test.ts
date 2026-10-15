import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiModelAdminRoutes } from '../src/modules/ai/model-admin-routes.js';

vi.mock('../src/modules/ai/catalog-seed.js', () => ({ ensureAiCatalogSeeded: vi.fn(async () => {}) }));

describe('Generic static request parameter management HTTP contract', () => {
  let app: FastifyInstance;
  let current: Record<string, unknown>;
  let updateMany: ReturnType<typeof vi.fn>;
  const originalConfig = { referenceSerializer: 'object_image_url', referenceTransport: 'data_url',
    resolutionParameter: 'size', resolutionValueMode: 'exact', exactDimensions: { '1K': { '16:9': '1280x720' } },
    generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/generations' };
  const task = { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations', statusEndpointTemplate: '/tasks/{taskId}',
    asyncParameterName: 'async', asyncParameterValue: true };
  const url = '/v1/admin/ai-models/routes/configured-route';

  beforeEach(async () => {
    current = { id: 'configured-route', canonicalModelId: 'model', canonicalModel: { modality: 'image' },
      upstreamModelId: 'arbitrary-upstream', adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: structuredClone(originalConfig),
      executionMode: 'TASK', executionConfig: task, costProfile: null, enabled: true, updatedAt: new Date(0) };
    updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(current, data); return { count: 1 }; });
    const transaction = { aiModelRoute: { findUnique: vi.fn(async () => current), updateMany, findUniqueOrThrow: vi.fn(async () => current) } };
    const prisma = { $transaction: async (callback: (client: typeof transaction) => unknown) => callback(transaction) } as unknown as PrismaClient;
    app = Fastify();
    app.decorate('prisma', prisma);
    await app.register(aiModelAdminRoutes, { prefix: '/v1/admin/ai-models' });
  });
  afterEach(async () => { await app.close(); });

  it('saves and returns the complete explicit configuration while preserving task, dimensions and mapping', async () => {
    const requestParameters = { type: 'imagine', n: 1, response_format: 'url', notify: false, seed: 0 };
    const config = { ...originalConfig, requestParameters, idempotencyHeader: 'Idempotency-Key', preserveTaskMetadata: true };
    const saved = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: config, expectedUpdatedAt: new Date(0).toISOString() } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ adapterConfig: config, upstreamModelId: 'arbitrary-upstream', executionMode: 'TASK', executionConfig: task });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'configured-route', updatedAt: new Date(0) }, data: { adapterConfig: config } });
    const edited = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: saved.json().adapterConfig } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().adapterConfig).toEqual(config);
  });

  it('does not add static parameters on an unchanged configuration and removes them when explicitly cleared', async () => {
    const unchanged = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: originalConfig } });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().adapterConfig).toEqual(originalConfig);
    const enabled = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...originalConfig,
      requestParameters: { type: 'imagine' }, preserveTaskMetadata: true } } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().adapterConfig.preserveTaskMetadata).toBe(true);
    const cleared = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: originalConfig } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().adapterConfig).toEqual(originalConfig);
    expect(cleared.json().adapterConfig).not.toHaveProperty('requestParameters');
    expect(cleared.json().adapterConfig).not.toHaveProperty('preserveTaskMetadata');
    expect(current.executionConfig).toEqual(task);
  });

  it.each([
    { model: 'override' }, { prompt: 'override' }, { async: false }, { images: 'override' },
    JSON.parse('{"__proto__":"override"}'), { constructor: 'override' },
    { n: 11 }, { response_format: 'png' }, { nested: { value: true } }, { label: 'x'.repeat(1001) },
    Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field_${index}`, index])),
  ])('rejects invalid configured parameters before writing a route %#', requestParameters => {
    return app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...originalConfig, requestParameters } } }).then(response => {
      expect(response.statusCode, response.body).toBe(400);
      expect(updateMany).not.toHaveBeenCalled();
      expect(current.adapterConfig).toEqual(originalConfig);
    });
  });

  it.each(['X-Request-ID', 'idempotency-key', '', true, null])('rejects unsupported idempotency opt-in %# before writing', async idempotencyHeader => {
    const response = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...originalConfig, idempotencyHeader } } });
    expect(response.statusCode, response.body).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([false, 'true', 1, null])('rejects non-true task-metadata opt-in %# before writing', async preserveTaskMetadata => {
    const response = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...originalConfig, preserveTaskMetadata } } });
    expect(response.statusCode, response.body).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('accepts matching count/format settings but rejects conflicting reference-only settings', async () => {
    const config = { ...originalConfig, referenceRequestCount: 1, referenceResponseFormat: 'url', requestParameters: { n: 1, response_format: 'url' } };
    const accepted = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: config } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().adapterConfig).toEqual(config);
    updateMany.mockClear();
    for (const requestParameters of [{ n: 2, response_format: 'url' }, { n: 1, response_format: 'b64_json' }]) {
      const response = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...config, requestParameters } } });
      expect(response.statusCode, response.body).toBe(400);
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  const operationsConfig = { ...originalConfig, requestParameters: { operation: 'imagine', speed: 'fast', n: 1 },
    idempotencyHeader: 'Idempotency-Key', preserveTaskMetadata: true, enableTaskOperations: true };

  it('saves the explicit operation opt-in on a Generic task route and supports clearing it', async () => {
    const saved = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: operationsConfig } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().adapterConfig).toEqual(operationsConfig);
    const cleared = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: originalConfig } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().adapterConfig).not.toHaveProperty('enableTaskOperations');
  });

  it.each([
    { preserveTaskMetadata: undefined }, { idempotencyHeader: undefined },
    { requestParameters: { operation: 'upscale', speed: 'fast', n: 1 } },
    { requestParameters: { operation: 'imagine', speed: 'unsupported', n: 1 } },
    { requestParameters: { operation: 'imagine', speed: 'fast', n: 2 } },
    { enableTaskOperations: false },
  ])('rejects incomplete operation permission configuration before any write %#', async override => {
    const response = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: { ...operationsConfig, ...override } } });
    expect(response.statusCode, response.body).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { executionMode: 'DIRECT', executionConfig: null },
    { executionMode: 'TASK', executionConfig: { ...task, profile: 'USELG_IMAGE' } },
  ])('rejects operations on an incompatible execution contract %#', async execution => {
    const response = await app.inject({ method: 'PATCH', url, payload: { adapterConfig: operationsConfig, ...execution } });
    expect(response.statusCode, response.body).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
