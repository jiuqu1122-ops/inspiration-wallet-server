import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  env: { SEARXNG_BASE_URL: 'http://searxng:8080' },
  execute: vi.fn(),
}));
vi.mock('../src/config/env.js', () => ({ env: fixtures.env }));
vi.mock('../src/modules/ai/service.js', () => ({ executeWalletAgentChat: fixtures.execute }));

import { webSearchRoutes } from '../src/modules/ai/web-search.js';

const query = {
  query: 'model catalogue',
  sourceDomain: 'example.org',
  limit: 6,
  clientRequestId: 'a'.repeat(32),
};
const indexResults = [
  { url: 'https://example.org/a', title: 'A', content: 'first' },
  { url: 'https://docs.example.org/b', title: 'B', content: 'second' },
  { url: 'https://example.org.other.test/fake', title: 'Wrong domain' },
  { url: 'http://127.0.0.1/private', title: 'Private' },
  { url: 'https://example.org/a#duplicate', title: 'Duplicate' },
];

describe('wallet web search', () => {
  let app: ReturnType<typeof Fastify>;
  const fetchIndex = vi.fn<typeof fetch>();

  beforeEach(async () => {
    fixtures.env.SEARXNG_BASE_URL = 'http://searxng:8080';
    fixtures.execute.mockReset();
    fetchIndex.mockReset();
    vi.stubGlobal('fetch', fetchIndex);
    app = Fastify();
    app.decorate('authenticateAccessToken', async (request, reply) => {
      if (request.headers.authorization !== 'Bearer test-token') {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      request.user = { sub: 'user-1', tokenType: 'access', sessionId: 'test', licenseId: 'test' };
    });
    await app.register(webSearchRoutes, { prefix: '/v1/web' });
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  const post = (operation: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/web/' + operation, headers: { authorization: 'Bearer test-token' }, payload,
  });

  it('requires a wallet session before requesting the configured engine', async () => {
    const result = await app.inject({ method: 'POST', url: '/v1/web/search', payload: query });
    expect(result.statusCode).toBe(401);
    expect(fetchIndex).not.toHaveBeenCalled();
  });

  it('uses the private engine and lets the wallet model order only verified candidate IDs', async () => {
    fetchIndex.mockResolvedValueOnce(Response.json({ results: indexResults }));
    fixtures.execute.mockImplementationOnce(async (_prisma, _body, options) => {
      options.searchRanking.validateResult({ choices: [{ message: { content: '[2]' } }] });
    });
    const result = await post('search', query);
    expect(result.statusCode).toBe(200);
    const [url, request] = fetchIndex.mock.calls[0]!;
    expect((url as URL).origin).toBe('http://searxng:8080');
    expect((url as URL).pathname).toBe('/search');
    expect((url as URL).searchParams.get('q')).toBe('site:example.org model catalogue');
    expect((url as URL).searchParams.get('format')).toBe('json');
    expect(request?.headers).toEqual({ accept: 'application/json' });
    expect(request?.redirect).toBe('error');
    expect(result.json()).toMatchObject({ provider: 'SearXNG', rankedByModel: true,
      results: [{ url: 'https://docs.example.org/b' }, { url: 'https://example.org/a' }] });
    const body = fixtures.execute.mock.calls[0]![1];
    expect(body).toMatchObject({ userId: 'user-1', clientRequestId: 'web-search-' + query.clientRequestId });
    expect(body).not.toHaveProperty('model');
    expect(JSON.parse(body.messages[1].content).candidates).toHaveLength(2);
  });

  it('returns engine order when the model is unavailable or provides an invalid ID', async () => {
    fetchIndex.mockImplementation(async () => Response.json({ results: indexResults }));
    fixtures.execute.mockRejectedValueOnce(new Error('Model route unavailable'));
    fixtures.execute.mockImplementationOnce(async (_prisma, _body, options) => {
      options.searchRanking.validateResult({ choices: [{ message: { content: '[99]' } }] });
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await post('search', query);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ rankedByModel: false,
        results: [{ url: 'https://example.org/a' }, { url: 'https://docs.example.org/b' }] });
    }
  });

  it('signals the desktop to fall back when the index is offline', async () => {
    fetchIndex.mockRejectedValueOnce(new Error('Engine unavailable'));
    expect((await post('search', query)).statusCode).toBe(503);
    expect(fixtures.execute).not.toHaveBeenCalled();
  });

  it('searches the CLI catalogue without sending wallet credentials or installing anything', async () => {
    fetchIndex.mockResolvedValueOnce(Response.json({ skills: [
      { id: 'anthropics/skills/frontend-design', source: 'anthropics/skills', name: 'frontend-design', installs: 12 },
      { id: 'example.org/unrelated', source: 'example.org', name: 'not a GitHub source' },
    ] }));
    const result = await post('skills', { query: 'frontend-design' });
    expect(result.statusCode).toBe(200);
    expect(result.json().results).toEqual([{
      title: 'frontend-design', url: 'https://github.com/anthropics/skills', source: 'anthropics/skills',
      catalogUrl: 'https://skills.sh/anthropics/skills/frontend-design', installs: 12,
    }]);
    const [url, request] = fetchIndex.mock.calls[0]!;
    expect((url as URL).href).toBe('https://skills.sh/api/search?q=frontend-design');
    expect(request?.headers).toEqual({ accept: 'application/json' });
    expect(fixtures.execute).not.toHaveBeenCalled();
  });
});
