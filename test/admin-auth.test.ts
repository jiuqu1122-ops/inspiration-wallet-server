import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminKeyMatches } from '../src/plugins/admin-auth.js';

describe('administrator key authentication', () => {
  it('accepts only the original secret for the configured SHA-256 hash', () => {
    const secret = 'admin-secret-that-is-longer-than-thirty-two-characters';
    const hash = createHash('sha256').update(secret).digest('hex');
    expect(adminKeyMatches(hash, secret)).toBe(true);
    expect(adminKeyMatches(hash, `${secret}-wrong`)).toBe(false);
  });

  it('rejects malformed hashes and short candidate keys', () => {
    expect(adminKeyMatches('', 'x'.repeat(64))).toBe(false);
    expect(adminKeyMatches('a'.repeat(64), 'too-short')).toBe(false);
  });
});
