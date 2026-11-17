import type { AiProviderChannel } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import * as referenceReader from '../src/modules/ai/seedream-references.js';
import { generatePreparedImageAdapterImages, prepareRouteImageAdapterRequest, collectImageStrings } from '../src/modules/ai/image-service.js';
import { stageMultipartImageReference } from '../src/modules/ai/seedream-references.js';
import { imageAdapterConfig } from '../src/modules/ai/image-adapters/types.js';
import { getImageResult, isStoredImageResultUrl } from '../src/modules/ai/image-result-store.js';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }));
const provider = { id: 'multipart-channel', kind: 'NEW_API', name: 'File fixture', baseUrl: 'https://provider.example' } as AiProviderChannel;
const secret = { apiKey: 'fixture-key-not-real', headers: {} };
const config = { referenceSerializer: 'multipart_image_array', maxReferenceImages: 10, maxPromptCharacters: 8000,
  resolutionParameter: 'resolution', resolutionValueMode: 'label', aspectRatioParameter: 'aspect_ratio',
  generationEndpoint: '/v1/images/generations', editEndpoint: '/v1/images/edits', async: true,
  idempotencyHeader: 'Idempotency-Key', requestParameters: { n: 1, response_format: 'url' } };
const route = (adapterKey = 'GENERIC_OPENAI_IMAGE', adapterConfig: unknown = config) => ({ adapterKey, adapterConfig,
  routeId: 'multipart-route', channelId: provider.id, upstreamModel: 'seedream-5.5', canonicalModelId: 'seedream55',
  canonicalModelKey: 'seedream55', requestedCanonicalModel: 'seedream55', resolvedCanonicalModel: 'seedream55',
  executionMode: 'TASK', executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
    statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary', resultEndpointTemplate: '/v1/images/tasks/{taskId}',
    asyncParameterName: 'async', asyncParameterValue: true } });
let files: Array<{ bytes: Buffer; mime: string }>;
let output: Buffer;
const results: string[] = [];
const sources = (count: number) => Array.from({ length: count }, (_, i) => {
  const f = files[i % files.length]!; return `data:${f.mime};base64,${f.bytes.toString('base64')}`;
});
const input = (refs = 0, changes = {}) => ({ userId: 'fixture-owner', clientRequestId: 'multipart-business-1', model: 'seedream-5.5',
  prompt: 'Keep subject one; use colors from reference two.', inputImages: sources(refs), resolution: '1k',
  aspectRatio: '16:9', count: 1, outputFormat: 'png' as const,
  imageCapabilities: { supportsReferenceImages: true, maxReferenceImages: 10 }, ...changes });
async function generate(refs = 0, options: { request?: Record<string, unknown>; cfg?: unknown; key?: string; receipt?: (identity: unknown) => Promise<void> } = {}) {
  const request = input(refs, options.request); const r = route(options.key, options.cfg ?? config);
  const prepared = await prepareRouteImageAdapterRequest(provider, request, r);
  const images = await generatePreparedImageAdapterImages(provider, secret, request, prepared!, r,
    { wait: async () => {}, onTaskSubmitted: options.receipt });
  results.push(...images.filter(isStoredImageResultUrl)); return images;
}
async function parseMultipart(url: string, init: RequestInit) {
  const request = new Request(url, init as RequestInit & { duplex: 'half' });
  return request.formData();
}
const inlineResult = () => Response.json({ data: [{ b64_json: output.toString('base64') }] });
beforeAll(async () => {
  output = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'yellow' } }).png().toBuffer();
  files = await Promise.all(['png', 'jpeg', 'webp'].map(async (format, i) => ({ mime: `image/${format}`,
    bytes: await sharp({ create: { width: 3, height: 2, channels: 3, background: ['red', 'green', 'blue'][i]! } })
      .toFormat(format as 'png' | 'jpeg' | 'webp').toBuffer() })));
});
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => {
  for (const url of results.splice(0)) { const value = await getImageResult(url.split('/').at(-1)!); if (value) await rm(value.path, { force: true }); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('explicit Seedream 5.5 multipart route: actual outgoing HTTP body', () => {
  it('keeps text-to-image JSON, n numeric 1 and exactly the original prompt, without quality or mask', async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://provider.example/v1/images/generations');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ model: 'seedream-5.5', prompt: input().prompt, resolution: '1K',
        aspect_ratio: '16:9', n: 1, response_format: 'url', async: true });
      return inlineResult();
    }); vi.stubGlobal('fetch', fetch);
    expect(await generate()).toEqual([`data:image/png;base64,${output.toString('base64')}`]); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([1, 3, 10])('sends %i real files in order as repeated image[] with a matching boundary', async count => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://provider.example/v1/images/edits');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${secret.apiKey}`);
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9]{64}$/);
      expect(headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=inspiration-/);
      const form = await parseMultipart(String(url), init);
      expect([...form.keys()].filter(k => k !== 'image[]').sort()).toEqual(['aspect_ratio','async','model','n','prompt','resolution','response_format']);
      for (const [key, value] of Object.entries({ model: 'seedream-5.5', prompt: input().prompt, n: '1', async: 'true',
        resolution: '1K', aspect_ratio: '16:9', response_format: 'url' })) expect(form.get(key)).toBe(value);
      const images = form.getAll('image[]') as File[]; expect(images).toHaveLength(count);
      for (let i = 0; i < count; i++) { expect(images[i]!.type).toBe(files[i % 3]!.mime);
        expect(Buffer.from(await images[i]!.arrayBuffer())).toEqual(files[i % 3]!.bytes); }
      return inlineResult();
    }); vi.stubGlobal('fetch', fetch); await generate(count); expect(fetch).toHaveBeenCalledOnce();
  });
  it('uses the same business idempotency key for retries and a new key for a new request', async () => {
    const keys: string[] = []; vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      keys.push(new Headers(init.headers).get('idempotency-key')!); await parseMultipart(String(url), init); return inlineResult();
    }));
    await generate(1); await generate(1); await generate(1, { request: { clientRequestId: 'multipart-business-2' } });
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
  });
  it.each(['GENERIC_OPENAI_IMAGE', 'SEEDREAM_IMAGES_API'])('supports explicit file mode on %s only, without public URL conversion', async key => {
    const prepared = await prepareRouteImageAdapterRequest(provider, input(1), route(key));
    expect(prepared).toMatchObject({ contentType: 'multipart/form-data', fileReferences: sources(1) });
    expect(prepared!.body).not.toHaveProperty('images'); expect(prepared!.body).not.toHaveProperty('image');
  });
  it('rejects 11 references, fixed count mismatch, a lower canonical limit and too-long prompts before any HTTP', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(generate(11)).rejects.toThrow(/at most 10/);
    await expect(generate(1, { request: { count: 2 } })).rejects.toThrow(/one image|output count/);
    await expect(generate(3, { request: { imageCapabilities: { maxReferenceImages: 2 } } })).rejects.toThrow(/at most 2/);
    await expect(generate(0, { request: { prompt: 'x'.repeat(8001) } })).rejects.toThrow(/8000/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not append size instructions to an exactly-8000-character user prompt', async () => {
    const prepared = await prepareRouteImageAdapterRequest(provider, input(1, { prompt: 'x'.repeat(8000) }), route());
    expect(prepared!.body.prompt).toBe('x'.repeat(8000));
  });
  it('keeps old JSON image-array routes JSON and their nine-reference ceiling', async () => {
    const old = { ...config, referenceSerializer: 'json_images', maxReferenceImages: 9, referenceTransport: 'data_url' };
    const prepared = await prepareRouteImageAdapterRequest(provider, input(1), route('GENERIC_OPENAI_IMAGE', old));
    expect(prepared!.contentType).toBe('application/json'); expect(prepared!.body.images).toHaveLength(1);
    await expect(generate(10, { cfg: old })).rejects.toThrow(/at most 9/);
    expect(() => imageAdapterConfig({ maxReferenceImages: 10 })).toThrow(/explicit/);
  });
  it('polls the original accepted task and downloads authenticated bytes, preserving the entire signed path and query', async () => {
    const asset = 'https://provider.example/v1/assets/image(1).png?sig=abc(123)&format=png';
    const seen: string[] = []; const receipt = vi.fn(async () => {});
    const fetch = vi.fn(async (url, init) => { seen.push(String(url));
      if (init?.method === 'POST') { await parseMultipart(String(url), init); return Response.json({ task_id: 'abc', status: 'processing' }, { status: 202 }); }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret.apiKey}`);
      if (String(url).includes('?view=summary')) return Response.json({ task_id: 'abc', status: 'success', assets: [{ download_url: asset }] });
      expect(String(url)).toBe(asset); return new Response(files[0]!.bytes, { headers: { 'content-type': 'image/png' } });
    }); vi.stubGlobal('fetch', fetch);
    const images = await generate(1, { receipt }); expect(isStoredImageResultUrl(images[0]!)).toBe(true);
    expect(seen).toEqual(['https://provider.example/v1/images/edits','https://provider.example/v1/images/tasks/abc?view=summary',asset]);
    expect(receipt).toHaveBeenCalledOnce();
  });
  it.each(['url', 'b64_json'])('accepts HTTP 200 final %s results without requiring task_id', async kind => {
    const cdn = 'https://cdn.example/output.png?sig=private-signature';
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') { await parseMultipart(String(url), init); return Response.json({ data: [{ [kind]: kind === 'url' ? cdn : output.toString('base64') }] }); }
      expect(String(url)).toBe(cdn); expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response(files[0]!.bytes, { headers: { 'content-type': 'image/png' } });
    }); vi.stubGlobal('fetch', fetch); expect(await generate(1)).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it.each([{ auto_poll: false }, { poll_after_ms: 0 }, { status: 'paused' }, { status: 'uncertain' }, { status: 'client_disconnected' }])(
    'holds an accepted request with %j without polling, replay or terminal failure', async control => {
      const fetch = vi.fn(async (url, init) => { await parseMultipart(String(url), init); return Response.json({ task_id: 'abc', status: 'processing', ...control }, { status: 202 }); });
      vi.stubGlobal('fetch', fetch); await expect(generate(1)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED' });
      expect(fetch).toHaveBeenCalledOnce();
    });
  it.each([500, 502, 503, 504, 0])('does not repeat an uncertain submit after HTTP %i or disconnect', async status => {
    const fetch = vi.fn(async (url, init) => { await parseMultipart(String(url), init);
      if (!status) throw new TypeError('fetch failed'); return new Response('uncertain', { status }); });
    vi.stubGlobal('fetch', fetch); await expect(generate(1)).rejects.toMatchObject({ code: 'AMBIGUOUS_SUBMIT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('treats an empty HTTP 200 as unknown rather than successful output', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { await parseMultipart(String(url), init); return Response.json({}); }));
    await expect(generate(1)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED', reason: 'missing_task_receipt' });
  });
  it('stages MIME-checked real files and removes temporary files on cleanup; invalid/truncated/GIF bytes are rejected', async () => {
    const staged = await stageMultipartImageReference(sources(1)[0]!, 0);
    expect(await readFile(staged.path)).toEqual(files[0]!.bytes); await staged.cleanup(); await expect(stat(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stageMultipartImageReference('data:image/jpeg;base64,' + files[0]!.bytes.toString('base64'), 0)).rejects.toThrow(/MIME/);
    await expect(stageMultipartImageReference('data:image/png;base64,' + files[0]!.bytes.subarray(0, 20).toString('base64'), 0)).rejects.toThrow(/invalid/);
    const gif = await sharp(files[0]!.bytes).gif().toBuffer();
    await expect(stageMultipartImageReference('data:image/gif;base64,' + gif.toString('base64'), 0)).rejects.toThrow(/PNG, JPEG and WebP/);
  });
  it('rejects private reference URLs without any fetch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(generate(1, { request: { inputImages: ['https://127.0.0.1/private.png'] } })).rejects.toThrow(/public HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not truncate structured signed image URLs while parsing shared responses', () => {
    const url = 'https://cdn.example/a(1).png?signature=abc(123)&last=.';
    expect(collectImageStrings({ data: [{ url }] })).toEqual([url]);
  });
  it('holds an aborted multipart submit and never retries a generation POST', async () => {
    const fetch = vi.fn(async (url, init) => {
      await parseMultipart(String(url), init);
      throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
    }); vi.stubGlobal('fetch', fetch);
    await expect(generate(1)).rejects.toMatchObject({ code: 'AMBIGUOUS_SUBMIT' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retries only an asset GET after a transient download error', async () => {
    let assetReads = 0;
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') { await parseMultipart(String(url), init); return Response.json({ task_id: 'abc', status: 'processing' }, { status: 202 }); }
      if (String(url).includes('view=summary')) return Response.json({ task_id: 'abc', status: 'success', assets: [{ download_url: '/v1/assets/result.png' }] });
      if (++assetReads === 1) return new Response('temporary', { status: 502 });
      return new Response(output, { headers: { 'content-type': 'image/png' } });
    }); vi.stubGlobal('fetch', fetch);
    expect(await generate(1)).toHaveLength(1); expect(assetReads).toBe(2);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('stops polling after the original status response pauses and retains that task identity', async () => {
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') { await parseMultipart(String(url), init); return Response.json({ task_id: 'abc', status: 'processing' }, { status: 202 }); }
      return Response.json({ task_id: 'abc', status: 'paused', auto_poll: false });
    }); vi.stubGlobal('fetch', fetch);
    await expect(generate(1)).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED', identity: { taskId: 'abc' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('enforces the elapsed submit deadline even if the fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    vi.spyOn(referenceReader, 'stageMultipartImageReference').mockImplementation(async (_source, index) => ({
      filename: `reference-${index}.png`, path: undefined as never, bytes: files[0]!.bytes,
      mime: 'image/png', size: files[0]!.bytes.length, cleanup: async () => {},
    }));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn(async () => { entered(); return new Promise<Response>(() => {}); });
    vi.stubGlobal('fetch', fetch);
    const work = generate(1).then(() => null, error => error);
    try {
      await started; await vi.advanceTimersByTimeAsync(60001);
      expect(await work).toMatchObject({ code: 'AMBIGUOUS_SUBMIT' }); expect(fetch).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(['1k', '1.5k', '2k'])('serializes resolution %s without introducing quality or size', async resolution => {
    const prepared = await prepareRouteImageAdapterRequest(provider, input(1, { resolution }), route());
    expect(prepared!.body.resolution).toBe(resolution.toUpperCase());
    expect(prepared!.body).not.toHaveProperty('quality'); expect(prepared!.body).not.toHaveProperty('size');
  });
  it('uses explicitly configured b64_json as a multipart text field', async () => {
    const fetch = vi.fn(async (url, init) => {
      expect((await parseMultipart(String(url), init)).get('response_format')).toBe('b64_json'); return inlineResult();
    }); vi.stubGlobal('fetch', fetch);
    await generate(1, { cfg: { ...config, requestParameters: { n: 1, response_format: 'b64_json' } } });
  });

  it('does not settle preview images attached to a terminal failed task', async () => {
    const fetch = vi.fn(async (url, init) => { await parseMultipart(String(url), init);
      return Response.json({ task_id: 'abc', status: 'failed', data: [{ b64_json: output.toString('base64') }] });
    }); vi.stubGlobal('fetch', fetch);
    await expect(generate(1)).rejects.toMatchObject({ code: 'IMAGE_TASK_FAILED' }); expect(fetch).toHaveBeenCalledOnce();
  });
  it('reads the original task result endpoint after success without assets', async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (url, init) => { seen.push(String(url));
      if (init?.method === 'POST') { await parseMultipart(String(url), init); return Response.json({ task_id: 'abc', status: 'processing' }, { status: 202 }); }
      if (String(url).includes('view=summary')) return Response.json({ task_id: 'abc', status: 'success', assets: [] });
      expect(String(url)).toBe('https://provider.example/v1/images/tasks/abc'); return inlineResult();
    }); vi.stubGlobal('fetch', fetch);
    expect(await generate(1)).toHaveLength(1); expect(seen).toHaveLength(3);
  });

  it('cleans every staged file even when the provider rejects before consuming the upload', async () => {
    const names = async () => (await readdir(tmpdir())).filter(name => name.startsWith('inspiration-multipart-ref-')).sort();
    const before = await names();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected before body consumption', { status: 401 })));
    await expect(generate(3)).rejects.toMatchObject({ status: 401 });
    expect(await names()).toEqual(before);
  });

  it('selects file serialization by route config rather than model name or domain', async () => {
    const request = input(1, { model: 'opaque-custom-image' });
    const r = { ...route(), upstreamModel: request.model, adapterConfig: { ...config, editEndpoint: '/custom/edit' },
      executionConfig: { ...route().executionConfig, submitEndpoint: '/independent/task-submit' } };
    const prepared = await prepareRouteImageAdapterRequest(provider, request, r);
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://provider.example/custom/edit');
      expect((await parseMultipart(String(url), init)).get('model')).toBe(request.model); return inlineResult();
    }); vi.stubGlobal('fetch', fetch);
    expect(await generatePreparedImageAdapterImages(provider, secret, request, prepared!, r, { wait: async () => {} })).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

});
