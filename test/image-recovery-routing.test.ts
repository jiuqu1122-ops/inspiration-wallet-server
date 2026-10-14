import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  recover: vi.fn(),
  lookup: vi.fn(),
  prisma: { authSession: { findUnique: vi.fn() } },
}));

vi.mock('../src/plugins/prisma.js', async () => {
  const { default: fp } = await import('fastify-plugin');
  return {
    prismaPlugin: fp(async app => { app.decorate('prisma', services.prisma as unknown as PrismaClient); }),
  };
});

vi.mock('../src/modules/ai/image-service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-service.js')>(),
  recoverWalletImageGeneration: services.recover,
  getWalletImageGenerationByRequest: services.lookup,
}));

import { buildApp } from '../src/app.js';
import * as imageService from '../src/modules/ai/image-service.js';

const owner = 'original-task-owner';
const sessionId = '6f029ae0-ec0b-4a41-a80a-4329658ca317';
const realRequestId = 'canvas_ai_canvas-1791644392538-d88168d8c3f841ef_c804c4b0-7212-48d8-9648-44-mv8ezeco-25a1f4d6-a53f-4152-b05b-1529cceac54f';

describe('image recovery through the production app router', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeEach(async () => {
    vi.clearAllMocks();
    services.prisma.authSession.findUnique.mockResolvedValue({
      userId: owner, licenseId: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { status: 'ACTIVE' }, license: null,
    });
    services.lookup.mockImplementation(async (_prisma, _userId, clientRequestId) => ({
      clientRequestId, status: 'PROCESSING', images: [], confirmationRequired: true,
    }));
    services.recover.mockImplementation(async (_prisma, _userId, clientRequestId) => ({
      clientRequestId, status: 'SUCCEEDED', images: ['https://fixture.example/recovered.png'],
    }));
    vi.spyOn(imageService, 'executeWalletImageGeneration');
    // Use buildApp so this test also fails when its routerOptions are omitted.
    // Replacing it with a separately configured Fastify would miss the regression.
    app = await buildApp();
    app.log.level = 'silent';
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ sub: owner, sessionId, tokenType: 'access' })}` };
  });

  afterEach(async () => {
    expect(imageService.executeWalletImageGeneration).not.toHaveBeenCalled();
    await app?.close();
  });

  it.each([
    ['a normal short ID', 'existing-task', 'existing-task'],
    ['the former 100-character boundary', 'x'.repeat(100), 'x'.repeat(100)],
    ['101 characters', 'x'.repeat(101), 'x'.repeat(101)],
    ['the original 120-character canvas ID', realRequestId, realRequestId],
    ['the supported 128-character boundary', 'x'.repeat(128), 'x'.repeat(128)],
    ['an encoded colon', 'canvas%3Aoriginal%3Atask', 'canvas:original:task'],
    ['128 decoded characters despite longer URL encoding', '%61'.repeat(128), 'a'.repeat(128)],
  ])('looks up and recovers %s without starting a generation', async (_label, encodedId, decodedId) => {
    const url = `/v1/ai/images/generations/by-request/${encodedId}`;
    const lookup = await app.inject({ method: 'GET', url, headers });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ clientRequestId: decodedId, status: 'PROCESSING' });
    expect(services.lookup).toHaveBeenCalledExactlyOnceWith(services.prisma, owner, decodedId);
    expect(services.recover).not.toHaveBeenCalled();

    const recovered = await app.inject({ method: 'POST', url: `${url}/recover`, headers, payload: {} });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({
      clientRequestId: decodedId, status: 'SUCCEEDED', images: ['https://fixture.example/recovered.png'],
    });
    expect(services.recover).toHaveBeenCalledExactlyOnceWith(services.prisma, owner, decodedId);
    expect(services.lookup).toHaveBeenCalledTimes(1);
    expect(services.prisma.authSession.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: sessionId } }));
  });

  it('requires real JWT authentication for long status and recovery URLs', async () => {
    for (const id of [realRequestId, 'x'.repeat(128)]) {
      const url = `/v1/ai/images/generations/by-request/${id}`;
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({
          method, url: method === 'GET' ? url : `${url}/recover`,
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toBe('unauthorized');
      }
    }
    expect(services.prisma.authSession.findUnique).not.toHaveBeenCalled();
    expect(services.lookup).not.toHaveBeenCalled();
    expect(services.recover).not.toHaveBeenCalled();
  });

  it('keeps IDs over 128 characters bounded before authentication or service calls', async () => {
    for (const id of ['x'.repeat(129), '%61'.repeat(129)]) {
      const url = `/v1/ai/images/generations/by-request/${id}`;
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({
          method, url: method === 'GET' ? url : `${url}/recover`, headers,
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(response.statusCode).toBe(414);
        expect(response.json()).toMatchObject({ code: 'FST_ERR_MAX_PARAM_LENGTH', statusCode: 414 });
      }
    }
    expect(services.prisma.authSession.findUnique).not.toHaveBeenCalled();
    expect(services.lookup).not.toHaveBeenCalled();
    expect(services.recover).not.toHaveBeenCalled();
  });
});
