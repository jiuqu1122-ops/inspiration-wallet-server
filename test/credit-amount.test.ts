import { describe, expect, it } from 'vitest';
import { creditDecimal, serializeCredit } from '../src/modules/wallets/credit-amount.js';

describe('decimal credit amounts', () => {
  it('preserves six fractional digits exactly', () => {
    expect(serializeCredit('1.284735')).toBe('1.284735');
    expect(serializeCredit(10n)).toBe('10.000000');
  });

  it('uses decimal arithmetic without binary floating-point drift', () => {
    expect(serializeCredit(creditDecimal('1.284735').plus('0.000001'))).toBe('1.284736');
  });
});
