import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { usageDiagnosticsRoutes } from '../src/modules/admin/usage-diagnostics-routes.js';

async function setup() {
  const app = Fastify();
  app.decorate('prisma', {
    aiRequest: { findMany: async () => [], count: async () => 0 },
    aiVideoTask: { findMany: async () => [] },
  } as unknown as PrismaClient);
  await app.register(async scoped => {
    scoped.addHook('preHandler', async (request, reply) => {
      if (request.headers.authorization !== 'Bearer test-admin-key') {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
    await scoped.register(usageDiagnosticsRoutes);
  }, { prefix: '/v1/admin' });
  await app.ready();
  return app;
}

describe('usage diagnostics route contract (requires repository dependencies)', () => {
  it('does not expose errors or metrics without admin authorization', async () => {
    const app = await setup();
    try {
      for (const url of ['/v1/admin/usage/errors', '/v1/admin/usage/metrics']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain('snapshotAt');
      }
    } finally { await app.close(); }
  });
  it('validates query limits and returns non-cacheable metadata only', async () => {
    const app = await setup();
    const headers = { authorization: 'Bearer test-admin-key' };
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/admin/usage/metrics?days=31', headers })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/usage/errors?limit=101', headers })).statusCode).toBe(400);
      const response = await app.inject({ method: 'GET', url: '/v1/admin/usage/metrics?days=1', headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().image).toEqual({ samples: 0, missingSamples: 0, averageMs: null });
      const errors = await app.inject({ method: 'GET', url: '/v1/admin/usage/errors?days=1', headers });
      expect(errors.statusCode).toBe(200);
      expect(errors.json().items).toEqual([]);
    } finally { await app.close(); }
  });
});
