import { describe, expect, it } from 'vitest';
import {
  createRedemptionCodeValue,
  hashRedemptionCode,
  normalizeRedemptionCode,
} from '../src/modules/wallets/redemption.js';

describe('credit redemption codes', () => {
  it('normalizes spacing, casing, and separators consistently', () => {
    expect(normalizeRedemptionCode(' unmind-abcde-fghjk-mnpqr '))
      .toBe('UNMINDABCDEFGHJKMNPQR');
    expect(hashRedemptionCode('UNMIND-ABCDE-FGHJK-MNPQR'))
      .toBe(hashRedemptionCode(' unmind abcde fghjk mnpqr '));
  });

  it('generates a readable high-entropy code', () => {
    expect(createRedemptionCodeValue())
      .toMatch(/^UNMIND-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });
});
