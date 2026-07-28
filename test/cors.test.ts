import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('browser CORS', () => {
  it('allows authenticated PATCH requests from the website admin console', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/admin/inspiration-space/00000000-0000-4000-8000-000000000000',
      headers: {
        origin: 'https://www.unmind.art',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://www.unmind.art');
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    await app.close();
  });

  it('allows DELETE requests used by moderation', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/admin/inspiration-space/00000000-0000-4000-8000-000000000000',
      headers: {
        origin: 'https://www.unmind.art',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    await app.close();
  });
});
