import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createTokenPair, verifyRefreshToken } from '../src/lib/tokens.js';
import { jwtPlugin } from '../src/plugins/jwt.js';

const userId = 'f6ddc2a2-b79d-43dc-82dc-3f302666c728';
const sessionId = '6f029ae0-ec0b-4a41-a80a-4329658ca317';
const licenseId = '318dd098-6bee-474a-b424-a86676da94a9';

describe('token pairs', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('issues isolated access and refresh tokens with session-bound claims', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(jwtPlugin);
    await app.ready();

    const pair = createTokenPair(app, userId, sessionId, licenseId);
    const accessClaims = app.jwt.verify(pair.accessToken);
    const refreshClaims = verifyRefreshToken(pair.refreshToken);

    expect(accessClaims).toMatchObject({
      sub: userId,
      sessionId,
      licenseId,
      tokenType: 'access',
    });
    expect(refreshClaims).toMatchObject({
      sub: userId,
      sessionId,
      licenseId,
      tokenType: 'refresh',
    });
    expect(() => app.jwt.verify(pair.refreshToken)).toThrow();
    expect(() => verifyRefreshToken(pair.accessToken)).toThrow();
  });

  it('supports account sessions that do not carry a legacy license claim', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(jwtPlugin);
    await app.ready();

    const pair = createTokenPair(app, userId, sessionId, null);
    expect(app.jwt.verify(pair.accessToken)).not.toHaveProperty('licenseId');
    expect(verifyRefreshToken(pair.refreshToken)).not.toHaveProperty('licenseId');
  });
});
