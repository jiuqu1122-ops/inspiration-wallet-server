import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../src/modules/ai/image-result-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/ai/image-result-store.js')>(),
  createImageResultFromResponse: vi.fn(async () => 'https://persisted.example/processed.png'),
}));

import { createImageResultFromResponse } from '../src/modules/ai/image-result-store.js';
import { buildNewApiImageGenerationBody, generateNewApiImages } from '../src/modules/ai/image-service.js';

const capabilities = { supportsTransparentBackground: true, supportedQualities: ['max'], qualityParameter: 'quality' };
const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const input = (model = 'gpt-image-2.5', imageCapabilities: unknown = capabilities): Parameters<typeof buildNewApiImageGenerationBody>[0] => ({
  userId: 'owner', clientRequestId: 'transparent-fixture', model, prompt: 'render a cutout',
  inputImages: [], aspectRatio: '16:9', resolution: '2k', outputFormat: 'png',
  background: 'transparent', quality: 'max', count: 1, imageCapabilities,
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('catalog-enabled Image 2.5 native transparency', () => {
  it.each(['gpt-image-2.5', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-10-15', 'gpt-image-2-5', 'image2.5'])
    ('serializes native alpha and a true transparency instruction for %s', model => {
      const body = buildNewApiImageGenerationBody(input(model), [], true, 'USELG');
      expect(body).toMatchObject({ model, output_format: 'png', background: 'transparent',
        quality: 'max', size: '2048x1152', response_format: 'url', async: true, n: 1, stream: false });
      expect(body.prompt).toContain('truly transparent background with an alpha channel');
      expect(body.prompt).not.toContain('RGB(255,0,255)');
    });

  it('retains the PNG transparency request when the caller omitted background', () => {
    const body = buildNewApiImageGenerationBody({ ...input(), background: undefined });
    expect(body).toMatchObject({ output_format: 'png', background: 'transparent' });
    expect(body.prompt).toContain('truly transparent background with an alpha channel');
    expect(body.prompt).not.toContain('RGB(255,0,255)');
  });

  it.each([false, undefined, 'true'])('preserves the legacy matte when native transparency is not explicitly enabled (%s)', flag => {
    const body = buildNewApiImageGenerationBody(input('gpt-image-2.5', { ...capabilities, supportsTransparentBackground: flag }));
    expect(body).toMatchObject({ output_format: 'png', quality: 'max', response_format: 'url' });
    expect(body).not.toHaveProperty('background');
    expect(body.prompt).toContain('RGB(255,0,255)');
  });

  it('keeps old GPT Image 2 matte behavior even when its capability flag is enabled', () => {
    const body = buildNewApiImageGenerationBody(input('gpt-image-2'));
    expect(body).toMatchObject({ output_format: 'png', response_format: 'url' });
    expect(body).not.toHaveProperty('background');
    expect(body.prompt).toContain('RGB(255,0,255)');
  });

  it('does not change ordinary JPG generation fields or add a background instruction', () => {
    const body = buildNewApiImageGenerationBody({ ...input(), outputFormat: 'jpg', background: undefined }, [], true, 'USELG');
    expect(body).toMatchObject({ quality: 'max', response_format: 'url', async: true, size: '2048x1152', n: 1 });
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
    expect(body.prompt).not.toContain('transparent background');
    expect(body.prompt).not.toContain('RGB(255,0,255)');
  });

  it.each([false, true])('preserves provider result bytes without chroma-key conversion (reference: %s)', async withReference => {
    // Native-alpha routes own their pixels; a magenta subject must not be keyed out.
    const generated = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff00ff' } }).png().toBuffer();
    let posted = '';
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posted = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()).toString('utf8');
      return new Response(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await generateNewApiImages(
      { id: 'native-fixture', kind: 'NEW_API', name: 'Fixture', baseUrl: 'https://provider.example' } as never,
      { apiKey: 'fixture', headers: {} }, { ...input(), inputImages: withReference ? [reference] : [] },
    );
    expect(result).toEqual([`data:image/png;base64,${generated.toString('base64')}`]);
    expect(createImageResultFromResponse).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://provider.example/v1/images/${withReference ? 'edits' : 'generations'}`);
    if (withReference) {
      expect(posted).toContain('name="background"\r\n\r\ntransparent');
      expect(posted).toContain('name="output_format"\r\n\r\npng');
    } else expect(JSON.parse(posted)).toMatchObject({ background: 'transparent', output_format: 'png' });
    expect(posted).not.toContain('RGB(255,0,255)');
  });
});
