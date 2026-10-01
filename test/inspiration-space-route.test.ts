import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  getInspirationPreviewRedirect: vi.fn(async () => (
    'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/'
    + 'inspiration-space/share/previews/preview.webp?signature=redacted'
  )),
  listPublishedInspirationShares: vi.fn(async () => ({ items: [], nextCursor: null })),
  getInspirationShareDownload: vi.fn(),
  createInspirationShare: vi.fn(),
}));

vi.mock('../src/modules/inspiration-space/service.js', () => ({
  INSPIRATION_SHARE_KINDS: ['NODE_PRESET', 'WORKFLOW', 'PROMPT', 'AGENT'],
  createInspirationShare: serviceMocks.createInspirationShare,
  getInspirationPreviewRedirect: serviceMocks.getInspirationPreviewRedirect,
  getInspirationShareDownload: serviceMocks.getInspirationShareDownload,
  getPublishedInspirationShare: vi.fn(),
  listPublishedInspirationShares: serviceMocks.listPublishedInspirationShares,
}));

import { inspirationSpaceRoutes } from '../src/modules/inspiration-space/routes.js';

describe('inspiration space preview route', () => {
  it('accepts PROMPT as a public list filter', async () => {
    const app = Fastify();
    app.decorate('prisma', {});
    await app.register(inspirationSpaceRoutes, { prefix: '/v1/inspiration-space' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/inspiration-space?kind=PROMPT&limit=1',
    });

    expect(response.statusCode).toBe(200);
    expect(serviceMocks.listPublishedInspirationShares).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ kind: 'PROMPT', limit: 1 }),
    );
    await app.close();
  });

  it('serves an agent as Markdown when requested for a file download', async () => {
    const app = Fastify();
    app.decorate('prisma', {});
    serviceMocks.getInspirationShareDownload.mockResolvedValueOnce({
      kind: 'AGENT',
      fileName: 'designer.md',
      jsonPayload: { type: 'inspiration-drawer-agent-share', version: 1, markdown: '# Designer\nCreate images.' },
    } as never);
    await app.register(inspirationSpaceRoutes, { prefix: '/v1/inspiration-space' });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/inspiration-space/737a116d-9dda-4dbc-80e0-881d57bdb3f0/download?format=markdown',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('designer.md');
    expect(response.body).toContain('# Designer');
    await app.close();
  });

  it('accepts an agent share for review and rejects a JSON file name', async () => {
    const app = Fastify();
    app.decorate('prisma', {});
    serviceMocks.createInspirationShare.mockResolvedValue({ id: 'share-1', status: 'PENDING' } as never);
    await app.register(inspirationSpaceRoutes, { prefix: '/v1/inspiration-space' });
    const body = {
      kind: 'AGENT', title: 'Designer', authorName: 'Tester', tags: [], fileName: 'SKILL.md',
      payload: { type: 'inspiration-drawer-agent-share', version: 1, markdown: '# Designer\nCreate images.' },
      previews: [],
    };
    const accepted = await app.inject({ method: 'POST', url: '/v1/inspiration-space', payload: body });
    expect(accepted.statusCode).toBe(201);
    expect(serviceMocks.createInspirationShare).toHaveBeenCalledWith({}, expect.objectContaining({ kind: 'AGENT', fileName: 'SKILL.md' }));
    const rejected = await app.inject({ method: 'POST', url: '/v1/inspiration-space', payload: { ...body, fileName: 'SKILL.json' } });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it('overrides the global same-origin policy for website images', async () => {
    const app = Fastify();
    app.decorate('prisma', {});
    await app.register(helmet, {
      contentSecurityPolicy: false,
      global: true,
    });
    await app.register(inspirationSpaceRoutes, { prefix: '/v1/inspiration-space' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/inspiration-space/assets/737a116d-9dda-4dbc-80e0-881d57bdb3f0',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers.location).toContain('signature=redacted');
    await app.close();
  });
});
