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
});
