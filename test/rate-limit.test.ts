import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('rate limit responses', () => {
  it('returns a compatible 429 response for email sync limits', async () => {
    const app = await buildApp();
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/auth/email/sync',
          payload: {},
        });
        expect(response.statusCode).toBe(400);
      }

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/sync',
        payload: {},
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: 'rate_limit_exceeded',
        message: 'Too many requests; try again later',
      });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(response.headers['x-ratelimit-limit']).toBe('20');
      expect(response.headers['x-ratelimit-remaining']).toBe('0');
    } finally {
      await app.close();
    }
  });
});
