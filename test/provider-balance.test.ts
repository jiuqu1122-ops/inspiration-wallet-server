import { describe, expect, it } from 'vitest';
import { normalizeProviderBalance } from '../src/modules/providers/service.js';

describe('provider balance normalization', () => {
  it('normalizes XAIS integer balance using its 10000 scale', () => {
    expect(normalizeProviderBalance('XAIS', 'userProfile', { balance: 250000 })).toMatchObject({
      available: true,
      totalAvailable: '25',
      currency: 'points',
    });
  });

  it('normalizes NewAPI grant and usage fields', () => {
    expect(normalizeProviderBalance('NEW_API', 'usage', {
      data: { total_granted: 120, total_used: 35 },
    })).toMatchObject({
      available: true,
      totalGranted: '120',
      totalUsed: '35',
      totalAvailable: '85',
    });
  });

  it('reports reachable responses without recognized balance fields', () => {
    expect(normalizeProviderBalance('NEW_API', 'usage', { data: { ok: true } })).toMatchObject({
      available: false,
      totalAvailable: null,
    });
  });
});
