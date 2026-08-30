import { beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: dnsMocks.lookup,
}));

import { assertPublicProviderUrl } from '../src/modules/providers/url.js';

describe('provider URL DNS SSRF protection', () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
  });

  it('rejects a provider hostname that resolves to a link-local address', async () => {
    dnsMocks.lookup.mockResolvedValue([{ address: '169.254.0.47', family: 4 }]);

    await expect(assertPublicProviderUrl('https://provider.example/v1'))
      .rejects.toThrow('did not resolve exclusively to public addresses');
  });

  it('rejects a provider hostname when any DNS answer is non-public', async () => {
    dnsMocks.lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '169.254.0.47', family: 4 },
    ]);

    await expect(assertPublicProviderUrl('https://provider.example/v1'))
      .rejects.toThrow('did not resolve exclusively to public addresses');
  });

  it('continues to reject literal loopback and private network addresses', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/image.png',
      'https://10.0.0.1/image.png',
      'https://192.168.1.1/image.png',
    ]) {
      await expect(assertPublicProviderUrl(url)).rejects.toThrow('not public');
    }
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
  });

  it('allows a normal third-party provider hostname only when every resolved address is public', async () => {
    dnsMocks.lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    await expect(assertPublicProviderUrl('https://provider.example/v1')).resolves.toBeUndefined();
  });
});
