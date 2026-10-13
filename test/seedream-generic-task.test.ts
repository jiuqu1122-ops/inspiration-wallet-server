import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { generatePreparedImageAdapterImages } from '../src/modules/ai/image-service.js';
import { getImageResult, isStoredImageResultUrl } from '../src/modules/ai/image-result-store.js';

vi.mock('../src/modules/providers/url.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/providers/url.js')>(),
  assertPublicProviderUrl: vi.fn(),
}));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=', 'base64');
const provider = { id: 'seedream-provider', name: 'Seedream', kind: 'NEW_API', baseUrl: 'https://provider.example' } as never;
const model = 'seedream-5.0-pro';
const prompt = 'private fixture prompt';
const secret = 'test-only-seedream-key';
const statusPath = '/v1/images/tasks/abc?view=summary';
const assetPath = '/v1/images/tasks/abc/assets/result.png';
const storedResults: string[] = [];

function fixture(submit: unknown, poll: unknown, result?: unknown, assetFailures = 0) {
  const requests: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  let statusReads = 0;
  let assetReads = 0;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    requests.push({ url: target.toString(), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    if (init?.method === 'POST') return json(submit);
    if (target.pathname === '/v1/images/tasks/abc') {
      // Bound failures on the old implementation without waiting fifteen minutes.
      if (++statusReads > 2) return new Response('fixture read exhausted', { status: 401 });
      return json(poll);
    }
    if (target.pathname === '/v1/images/tasks/abc/result' && result !== undefined) return json(result);
    if (++assetReads <= assetFailures) return new Response('fixture temporary failure', { status: 502 });
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  }));
  return requests;
}

async function generate(executionConfig: Record<string, unknown> = {}) {
  const images = await generatePreparedImageAdapterImages(provider, { apiKey: secret, headers: {} }, {
    userId: 'fixture-user', clientRequestId: 'seedream-request', model, prompt,
    inputImages: [], aspectRatio: '1:1', resolution: '2k', outputFormat: 'png', count: 1,
  }, {
    adapterKey: 'GENERIC_OPENAI_IMAGE', execution: 'images-api', submittedModel: model,
    endpoint: '/v1/images/generations', method: 'POST', contentType: 'application/json',
    body: { model, prompt, size: '2048x2048', async: true },
  }, {
    adapterKey: 'GENERIC_OPENAI_IMAGE', adapterConfig: null, executionMode: 'TASK',
    executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations',
      statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary', ...executionConfig },
    requestedCanonicalModel: model, resolvedCanonicalModel: model, canonicalModelId: 'seedream-canonical',
    canonicalModelKey: model, routeId: 'seedream-route', channelId: 'seedream-provider', upstreamModel: model,
  }, { wait: async () => undefined });
  storedResults.push(...images.filter(isStoredImageResultUrl));
  return images;
}

async function expectStoredImage(images: string[]) {
  expect(images).toHaveLength(1);
  expect(isStoredImageResultUrl(images[0]!)).toBe(true);
  const stored = await getImageResult(images[0]!.split('/').at(-1)!);
  expect(stored).not.toBeNull();
  expect(await readFile(stored!.path)).toEqual(png);
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const source of storedResults.splice(0)) {
    const stored = await getImageResult(source.split('/').at(-1)!);
    if (stored) await rm(stored.path, { force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('Seedream Images API Generic TASK result delivery', () => {
  it('submits async and resolves data.id plus an authenticated relative download_url', async () => {
    const requests = fixture({ task_id: 'abc' }, { data: { id: 'abc', status: 'success', assets: [{ download_url: assetPath }] } });
    await expectStoredImage(await generate());
    expect(requests[0]).toMatchObject({ method: 'POST', body: { model, prompt, size: '2048x2048', async: true } });
    expect(requests.filter(row => row.method === 'POST')).toHaveLength(1);
    expect(requests[1]?.url).toBe(`https://provider.example${statusPath}`);
    expect(requests[2]?.url).toBe(`https://provider.example${assetPath}`);
    expect(requests[2]?.headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(console.info).toHaveBeenCalledWith('[image_adapter_submit_completed]', expect.objectContaining({
      clientRequestId: 'seedream-request', taskId: 'abc', profile: 'GENERIC_TASK',
      upstreamModel: model, configuredModel: model, submittedModel: model,
      statusUrl: `https://provider.example${statusPath}`,
    }));
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).not.toContain(secret); expect(logs).not.toContain(prompt); expect(logs).not.toContain(png.toString('base64'));
  });

  it.each([
    { task_id: 'xyz', status: 'success', assets: [{ download_url: assetPath }] },
    { data: { id: 'xyz', status: 'success', assets: [{ download_url: assetPath }] } },
    { result: { task_id: 'xyz', status: 'success', assets: [{ download_url: assetPath }] } },
  ])('requires recovery for a clearly different task before acquiring its image: %j', async poll => {
    const requests = fixture({ task_id: 'abc' }, poll);
    await expect(generate()).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED', reason: 'task_identity_mismatch', identity: { taskId: 'abc' } });
    expect(requests).toHaveLength(2);
    expect(requests.filter(row => row.method === 'POST')).toHaveLength(1);
  });

  it('reads success + empty assets + result_url containing image bytes', async () => {
    fixture({ task_id: 'abc' }, { task_id: 'abc', status: 'success', assets: [], result_url: assetPath });
    await expectStoredImage(await generate());
  });

  it('reads a result_url JSON envelope and downloads its asset', async () => {
    fixture({ task_id: 'abc' }, { task_id: 'abc', status: 'success', assets: [], result_url: '/v1/images/tasks/abc/result' },
      { result: { task_id: 'abc', assets: [{ download_url: assetPath }] } });
    await expectStoredImage(await generate());
  });

  it('reads result_url immediately when the submit receipt is already successful', async () => {
    const requests = fixture({ task_id: 'abc', status: 'success', assets: [], result_url: assetPath }, {});
    await expectStoredImage(await generate());
    expect(requests.map(row => new URL(row.url).pathname)).toEqual(['/v1/images/generations', assetPath]);
  });

  it('reads a public binary result_url without forwarding the provider key', async () => {
    const resultUrl = 'https://cdn.example/result.png?token=private-result-token';
    const requests = fixture({ task_id: 'abc' }, { task_id: 'abc', status: 'success', result_url: resultUrl });
    await expectStoredImage(await generate());
    expect(requests.find(row => row.url === resultUrl)?.headers.get('authorization')).toBeNull();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private-result-token');
  });

  it('checks the result envelope identity before downloading any result assets', async () => {
    const requests = fixture({ task_id: 'abc' }, { task_id: 'abc', status: 'success', result_url: '/v1/images/tasks/abc/result' },
      { result: { task_id: 'xyz', assets: [{ download_url: assetPath }] } });
    await expect(generate()).rejects.toMatchObject({ code: 'IMAGE_TASK_RECOVERY_REQUIRED', reason: 'task_identity_mismatch', identity: { taskId: 'abc' } });
    expect(requests).toHaveLength(3);
  });

  it('downloads success + assets[0].download_url', async () => {
    fixture({ task_id: 'abc' }, { task_id: 'abc', status: 'success', assets: [{ download_url: `https://provider.example${assetPath}` }] });
    await expectStoredImage(await generate());
  });

  it.each([{ data: { task_id: 'abc' } }, { result: { task_id: 'abc' } }, { response: { id: 'abc' } }, { id: 'abc' }])(
    'accepts a moved submit receipt without confusing it with a different task: %j', async submit => {
      fixture(submit, { data: { id: 'abc', status: 'success', assets: [{ download_url: assetPath }] } });
      await expectStoredImage(await generate());
    },
  );

  it('downloads a signed_url directly without provider credentials or signed query diagnostics', async () => {
    const signed = 'https://cdn.example/result.png?signature=private-signature';
    const requests = fixture({ task_id: 'abc' }, { status: 'success', assets: [{ signed_url: signed }] });
    await expectStoredImage(await generate());
    const downloaded = requests.find(row => row.url === signed);
    expect(downloaded?.headers.get('authorization')).toBeNull();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private-signature');
  });

  it('uses the confirmed Seedream task contract when only profile and submitEndpoint are configured', async () => {
    fixture({ task_id: 'abc' }, { status: 'success', assets: [{ download_url: assetPath }] });
    await expectStoredImage(await generate({ statusEndpointTemplate: undefined }));
  });

  it('prefers a nested task_id over an unrelated response-envelope id', async () => {
    fixture({ task_id: 'abc' }, { id: 'response-envelope-id', data: { task_id: 'abc', status: 'success', assets: [{ download_url: assetPath }] } });
    await expectStoredImage(await generate());
  });

  it('adds summary to a provider-returned image task status_url', async () => {
    const requests = fixture({ task_id: 'abc', status_url: '/v1/images/tasks/abc' }, { status: 'success', assets: [{ download_url: assetPath }] });
    await expectStoredImage(await generate());
    expect(requests[1]?.url).toBe(`https://provider.example${statusPath}`);
  });

  it('retries the same asset GET after a 502 while keeping the generation POST count at one', async () => {
    const requests = fixture({ task_id: 'abc' }, { status: 'success', assets: [{ download_url: assetPath }] }, undefined, 1);
    await expectStoredImage(await generate());
    expect(requests.filter(row => row.method === 'POST')).toHaveLength(1);
    expect(requests.filter(row => row.url === `https://provider.example${assetPath}`)).toHaveLength(2);
  });
});
