import { describe, expect, it } from 'vitest';
import { emailAuthInternals } from '../src/modules/auth/email-auth.js';

describe('email authentication helpers', () => {
  it('normalizes email addresses without changing their identity later', () => {
    expect(emailAuthInternals.normalizeEmail('  Designer@Example.COM ')).toBe('designer@example.com');
  });

  it('hashes one-time codes with the challenge and email context', () => {
    const first = emailAuthInternals.codeHash('challenge-a', 'user@example.com', '123456');
    const second = emailAuthInternals.codeHash('challenge-b', 'user@example.com', '123456');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('123456');
  });

  it('accepts only useful display names', () => {
    expect(emailAuthInternals.validDisplayName('  张三设计  ')).toBe('张三设计');
    expect(emailAuthInternals.validDisplayName('a')).toBeNull();
    expect(emailAuthInternals.validDisplayName('a\nb')).toBeNull();
  });

  it('does not inherit an expired desktop license date during email migration', () => {
    const now = new Date('2026-09-12T00:00:00.000Z');
    expect(emailAuthInternals.latestFutureExpiration(
      now,
      new Date('2026-09-11T23:59:59.999Z'),
      null,
    )).toBeNull();
  });

  it('keeps the latest future entitlement when legacy dates are still valid', () => {
    const now = new Date('2026-09-12T00:00:00.000Z');
    const latest = new Date('2026-10-01T23:59:59.999Z');
    expect(emailAuthInternals.latestFutureExpiration(
      now,
      new Date('2026-09-20T23:59:59.999Z'),
      latest,
    )).toEqual(latest);
  });
});
