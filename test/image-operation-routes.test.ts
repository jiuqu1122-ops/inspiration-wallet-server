import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiRoutes } from '../src/modules/ai/routes.js';
import { submitWalletImageOperation, getWalletImageOperation } from '../src/modules/ai/image-operation-service.js';
import { CloudAiError } from '../src/modules/ai/service.js';

vi.mock('../src/modules/ai/image-operation-service.js', () => ({
  submitWalletImageOperation: vi.fn(), getWalletImageOperation: vi.fn(),
}));

describe('authenticated image operation HTTP boundary', () => {
  let app: FastifyInstance;
  const body = { clientRequestId: 'new-operation-001', model: 'configured-image-model', operation: 'imagine', prompt: 'a quiet mountain' };
  const result = { clientRequestId: body.clientRequestId, status: 'queued', operation: 'imagine', speed: 'fast',
    images: [], texts: [], uploadedUrls: [], requiresModal: false, chargedCredits: '0.000000' };
  const headers = { authorization: 'Bearer owner' };
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(submitWalletImageOperation).mockResolvedValue(result as never);
    vi.mocked(getWalletImageOperation).mockResolvedValue(result as never);
    app = Fastify();
    app.decorate('prisma', {} as PrismaClient);
    app.decorate('authenticateAccessToken', async (request, reply) => {
      if (!request.headers.authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
      request.user = { sub: request.headers.authorization.slice(7) } as typeof request.user;
    });
    await app.register(aiRoutes, { prefix: '/v1/ai' });
  });
  afterEach(async () => { await app.close(); });

  it('uses the authenticated owner and returns an accepted receipt without exposing transport controls', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/ai/images/operations', headers, payload: body });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(result);
    expect(submitWalletImageOperation).toHaveBeenCalledWith(app.prisma, { ...body, userId: 'owner' });
  });

  it.each(['success', 'failed', 'canceled', 'client_disconnected'])('returns a final %s operation without implying another submission', async status => {
    vi.mocked(submitWalletImageOperation).mockResolvedValue({ ...result, status } as never);
    const response = await app.inject({ method: 'POST', url: '/v1/ai/images/operations', headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(submitWalletImageOperation).toHaveBeenCalledOnce();
  });

  it.each([{ userId: 'other-owner' }, { price: 0 }, { operationUnitCredits: '0' }, { n: 4 },
    { parent_task_id: 'foreign-task' }, { headers: { Authorization: 'foreign' } }, { operation: 'mj_upscale' }])('rejects untrusted or unknown body parameters %# before service dispatch', async extra => {
    const response = await app.inject({ method: 'POST', url: '/v1/ai/images/operations', headers, payload: { ...body, ...extra } });
    expect(response.statusCode).toBe(400);
    expect(submitWalletImageOperation).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'POST' as const, url: '/v1/ai/images/operations', payload: body },
    { method: 'GET' as const, url: '/v1/ai/images/operations/by-request/new-operation-001' },
    { method: 'POST' as const, url: '/v1/ai/images/operations/by-request/new-operation-001/refresh' },
  ])('authenticates $method $url', async request => {
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(submitWalletImageOperation).not.toHaveBeenCalled();
    expect(getWalletImageOperation).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'] as const)('refreshes by the owner request ID using %s without entering the submission service', async method => {
    const response = await app.inject({ method, url: '/v1/ai/images/operations/by-request/new-operation-001' + (method === 'POST' ? '/refresh' : ''), headers });
    expect(response.statusCode).toBe(200);
    expect(getWalletImageOperation).toHaveBeenCalledWith(app.prisma, 'owner', body.clientRequestId, { refresh: true });
    expect(submitWalletImageOperation).not.toHaveBeenCalled();
  });

  it('returns 404 for an unavailable owner result and rejects refresh bodies that could create an action', async () => {
    vi.mocked(getWalletImageOperation).mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/v1/ai/images/operations/by-request/new-operation-001', headers })).statusCode).toBe(404);
    const before = vi.mocked(getWalletImageOperation).mock.calls.length;
    const response = await app.inject({ method: 'POST', url: '/v1/ai/images/operations/by-request/new-operation-001/refresh', headers, payload: { actionId: 'create-action' } });
    expect(response.statusCode).toBe(400);
    expect(getWalletImageOperation).toHaveBeenCalledTimes(before);
  });

  it('reports service authorization conflicts with their original error code', async () => {
    vi.mocked(submitWalletImageOperation).mockRejectedValue(new CloudAiError('image_operation_action_unavailable', 'Action not owned', 409));
    const response = await app.inject({ method: 'POST', url: '/v1/ai/images/operations', headers, payload: body });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'image_operation_action_unavailable' });
  });
});
