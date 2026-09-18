import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('legacy admin pricing routes', () => {
  it('does not register legacy AI or Chat pricing endpoints', async () => {
    const source = await readFile(new URL('../src/modules/admin/routes.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/app\.(?:get|patch)\('\/(?:chat-)?pricing'/);
    expect(source).not.toContain('updateLegacyAiPricingAndPublish');
    expect(source).not.toContain('updateLegacyChatPricingAndPublish');
  });
});
