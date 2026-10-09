import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { jwtPlugin } from '../src/plugins/jwt.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const claims = { sub: 'test-user-private', sessionId: '6f029ae0-ec0b-4a41-a80a-4329658ca317', tokenType: 'access' };

async function fixture(revoked = false) {
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { logs.push(line); } } } });
  apps.push(app);
  const findUnique = vi.fn(async () => ({ userId: claims.sub, licenseId: null,
    revokedAt: revoked ? new Date() : null, expiresAt: new Date(Date.now() + 60_000), user: { status: 'ACTIVE' }, license: null }));
  app.decorate('prisma', { authSession: { findUnique } } as unknown as typeof app.prisma);
  await app.register(jwtPlugin);
  app.get('/private', { preHandler: app.authenticateAccessToken }, async () => ({ ok: true }));
  await app.ready();
  return { app, logs, findUnique };
}

it('separates missing, expired, invalid and malformed claims without leaking credentials', async () => {
  const { app, logs, findUnique } = await fixture();
  const expired = app.jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 });
  const valid = app.jwt.sign(claims);
  const parts = valid.split('.');
  parts[2] = (parts[2]!.startsWith('a') ? 'b' : 'a') + parts[2]!.slice(1);
  const invalid = parts.join('.');
  const malformed = app.jwt.sign({ ...claims, sessionId: 'private-malformed-session' });
  for (const token of [undefined, expired, invalid, malformed]) {
    const response = await app.inject({ method: 'GET', url: '/private', headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'A valid access token is required' });
  }
  expect(findUnique).not.toHaveBeenCalled();
  const records = logs.map(line => JSON.parse(line) as { category: string });
  expect(records.map(r => r.category)).toEqual(['authorization_missing', 'token_expired', 'token_verification_failed', 'claims_invalid']);
  const output = logs.join('');
  for (const sensitive of [claims.sub, claims.sessionId, expired, valid, invalid, malformed, 'private-malformed-session']) {
    expect(output).not.toContain(sensitive);
  }
});

it('distinguishes revoked sessions and preserves valid access behavior', async () => {
  const rejected = await fixture(true);
  const response = await rejected.app.inject({ method: 'GET', url: '/private', headers: {
    authorization: `Bearer ${rejected.app.jwt.sign(claims)}`, 'x-client-version': '8.0.21',
  } });
  expect(response.statusCode).toBe(401);
  expect(JSON.parse(rejected.logs[0]!)).toMatchObject({ category: 'session_revoked', clientVersion: '8.0.21' });
  const accepted = await fixture();
  const ok = await accepted.app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${accepted.app.jwt.sign(claims)}` } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ ok: true });
  expect(accepted.logs).toEqual([]);
});
