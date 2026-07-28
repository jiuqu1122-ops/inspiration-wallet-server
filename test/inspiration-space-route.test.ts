import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  getInspirationPreviewRedirect: vi.fn(async () => (
    'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/'
    + 'inspiration-space/share/previews/preview.webp?signature=redacted'
  )),
}));

vi.mock('../src/modules/inspiration-space/service.js', () => ({
  INSPIRATION_SHARE_KINDS: ['NODE_PRESET', 'WORKFLOW'],
  createInspirationShare: vi.fn(),
  getInspirationPreviewRedirect: serviceMocks.getInspirationPreviewRedirect,
  getInspirationShareDownload: vi.fn(),
  getPublishedInspirationShare: vi.fn(),
  listPublishedInspirationShares: vi.fn(),
}));

import { inspirationSpaceRoutes } from '../src/modules/inspiration-space/routes.js';

describe('inspiration space preview route', () => {
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
