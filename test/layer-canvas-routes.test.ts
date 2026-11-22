import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { startLayerMock } from './fixtures/layer-canvas-mock.js';
import { readFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';
import { storageService } from '../src/modules/storage/service.js';

vi.mock('node:dns/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: vi.fn(async (hostname: string) => [{
    address: hostname === 'cos.internal.example.test' || hostname.endsWith('.myqcloud.com') ? '10.0.3.2' : '1.1.1.1', family: 4,
  }]),
}));

let mock: Awaited<ReturnType<typeof startLayerMock>>;
beforeAll(async () => { mock = await startLayerMock(4147); }, 15000);
afterAll(async () => { await mock?.close(); });

test('deduplicates an in-flight split and charges its fixed price across all layers', async () => {
  expect((await mock.app.inject('/v1/ai/catalog')).json().canvasLayers).toMatchObject({
    split: [{ creditsPerRequest: '12.000000' }], edit: [{ creditsPerRequest: '8.000000' }],
  });
  const payload = { operation: 'split', prompt: '', image: mock.paths.poster, clientRequestId: 'dedup-split-001', expectedCredits: '12' };
  const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload });
  const [first, duplicate] = await Promise.all([post(), post()]);
  expect([first.statusCode, duplicate.statusCode].sort()).toEqual([200, 202]);
  const result = (await mock.app.inject('/v1/ai/canvas-layers/by-request/' + payload.clientRequestId)).json();
  expect(result).toMatchObject({ status: 'success', model: 'local-layer-model', chargedCredits: '12.000000',
    result: { width: 320, height: 400, layers: [{ name: '标题', alpha: true }, { name: '云朵', transparent: true, x: 100, y: 175 }] } });
  expect(result.result.assets).toHaveLength(3);
  const png = await mock.app.inject(new URL(result.result.assets[2]).pathname);
  expect(png.headers['content-type']).toBe('image/png');
  expect(png.rawPayload.subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]));
  expect((await post()).json()).toEqual(result);
  const changed = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: { ...payload, prompt: 'changed' } });
  expect(changed.statusCode).toBe(409);
  const stats = (await mock.app.inject('/fixture/receipt')).json();
  expect(stats.calls.filter((call: {action: string}) => call.action === 'split')).toHaveLength(1);
  expect(mock.upstreamCalls().at(-1)?.customTransport).toBe(false);
  expect(stats.balance).toBe('88');
  expect(stats.reservations).toBe('0');
});

test('chooses a separately configured channel and serializes the selection in supplier pixels', async () => {
  const draft = { enabled: true, endpoint: '/edit', adapter: 'canvas-json', creditsPerRequest: '8',
    maxMegapixels: 2, maxLayers: 1 };
  const routeSettings = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/edit';
  const save = (config: typeof draft | null) => mock.app.inject({ method: 'PUT', url: routeSettings, payload: { config } });
  expect((await save({ ...draft, endpoint: '//foreign.example/edit' })).statusCode).toBe(400);
  expect((await save(null)).statusCode).toBe(200);
  try {
    const payload = { operation: 'edit', prompt: 'Color', image: mock.paths.poster, clientRequestId: 'route-edit-001', expectedCredits: '8',
      selection: { kind: 'rect', x: 0.25, y: 0.1, width: 0.25, height: 0.5 } };
    const result = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload });
    expect(result.json()).toMatchObject({ status: 'success', chargedCredits: '8.000000',
      result: { operation: 'edit', image: { width: 320, height: 400 } } });
    expect((await mock.app.inject('/fixture/receipt')).json().calls.at(-1)).toEqual({
      channel: 'mock-b', action: 'retouch', selection: [80, 40, 160, 240],
    });
    const misplaced = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers',
      payload: { ...payload, baseUrl: 'https://example.com' } });
    expect(misplaced.statusCode).toBe(400);
  } finally { await save(draft); }
});

test('uses the former base rate as the fixed price and accepts earlier clients', async () => {
  const common = { enabled: true, endpoint: '/edit', adapter: 'canvas-json', maxMegapixels: 2, maxLayers: 1 };
  const route = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/edit';
  const save = (config: object) => mock.app.inject({ method: 'PUT', url: route, payload: { config } });
  expect((await save({ ...common, baseCredits: '2.5', perMegapixelCredits: '9' })).statusCode).toBe(200);
  try {
    expect((await mock.app.inject('/v1/ai/catalog')).json().canvasLayers.edit[0].creditsPerRequest).toBe('2.500000');
    const result = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'edit', model: 'local-layer-model', image: mock.paths.poster,
      prompt: 'Color', clientRequestId: 'legacy-model-001',
    } });
    expect(result.json()).toMatchObject({ status: 'success', model: 'local-layer-model', chargedCredits: '2.500000' });
  } finally { await save({ ...common, creditsPerRequest: '8' }); }
});

test('configures each task independently and routes new requests through its selected channel', async () => {
  const adminPath = '/v1/admin/ai-models/layer-tasks';
  const modelKey = 'local-layer-model';
  const routeConfig = { enabled: true, endpoint: '/edit', adapter: 'pixel-json', creditsPerRequest: '3.25', maxMegapixels: 2, maxLayers: 1 };
  const settings = async () => (await mock.app.inject(adminPath)).json();
  const save = (routeId: string, config: typeof routeConfig) => mock.app.inject({
    method: 'PUT', url: `${adminPath}/edit`, payload: { modelKey, routeId, config },
  });
  expect((await settings()).items).toMatchObject({
    split: { modelKey, currentRoute: { id: 'mock-a', creditsPerRequest: '12.000000' } },
    edit: { modelKey, currentRoute: { id: 'mock-a', creditsPerRequest: '8.000000' } },
  });

  expect((await save('mock-b', routeConfig)).statusCode).toBe(200);
  try {
    const current = await settings();
    expect(current.items).toMatchObject({
      split: { modelKey, currentRoute: { id: 'mock-a', creditsPerRequest: '12.000000' } },
      edit: { modelKey, currentRoute: { id: 'mock-b', creditsPerRequest: '3.250000' } },
    });
    expect(current.models[0].routes[1].configs.edit).toMatchObject(routeConfig);
    expect(current.models[0].routes[1].channel).not.toHaveProperty('encryptedSecrets');
    expect((await mock.app.inject('/v1/ai/catalog')).json().canvasLayers.edit[0].creditsPerRequest).toBe('3.250000');

    const result = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'edit', model: 'previous-client-model', image: mock.paths.poster,
      prompt: 'Color', clientRequestId: 'layer-task-edit-01', expectedCredits: '3.25',
      selection: { kind: 'point', x: 0.25, y: 0.25 },
    } });
    expect(result.json()).toMatchObject({ status: 'success', model: modelKey, chargedCredits: '3.250000' });
    expect((await mock.app.inject('/fixture/receipt')).json().calls.at(-1)).toMatchObject({ channel: 'mock-b' });

    const defaultConfig = { ...routeConfig, adapter: 'canvas-json', creditsPerRequest: '8' };
    expect((await save('mock-a', defaultConfig)).statusCode).toBe(200);
    expect((await settings()).items.edit.currentRoute.id).toBe('mock-a');
  } finally {
    await save('mock-b', { ...routeConfig, creditsPerRequest: '8', maxLayers: 32 });
    await save('mock-a', { ...routeConfig, adapter: 'canvas-json', creditsPerRequest: '8', maxLayers: 32 });
  }
});

test('rejects a changed price before sending upstream and refunds a failed fixed-price request', async () => {
  const route = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split';
  const common = { enabled: true, adapter: 'canvas-json', maxMegapixels: 2, maxLayers: 32 };
  const save = (endpoint: string, creditsPerRequest: string) => mock.app.inject({
    method: 'PUT', url: route, payload: { config: { ...common, endpoint, creditsPerRequest } },
  });
  const stats = async () => (await mock.app.inject('/fixture/receipt')).json();
  expect((await save('/unavailable', '15')).statusCode).toBe(200);
  try {
    const before = await stats();
    const payload = { operation: 'split', image: mock.paths.poster, clientRequestId: 'price-change-001' };
    const post = (expectedCredits: string) => mock.app.inject({
      method: 'POST', url: '/v1/ai/canvas-layers', payload: { ...payload, expectedCredits },
    });
    const stale = await post('12');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('layer_price_changed');
    expect(await stats()).toEqual(before);

    const failed = await post('15');
    expect(failed.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000' });
    const after = await stats();
    expect(after.balance).toBe(before.balance);
    expect(after.reservations).toBe('0');
    expect(after.ledger.slice(-2)).toEqual([{ type: 'RESERVE', amount: '-15' }, { type: 'RELEASE', amount: '15' }]);
    expect((await post('15')).json()).toEqual(failed.json());
    expect(await stats()).toEqual(after);
  } finally { await save('/split', '12'); }
});

test('creates and checks an Ark channel with the authenticated, read-only model catalog', async () => {
  const url = '/v1/admin/providers';
  const created = await mock.app.inject({ method: 'POST', url, payload: {
    kind: 'VOLCENGINE_ARK', name: 'Ark fixture', baseUrl: 'https://8.8.8.8/api/v3/images/generations',
    apiKey: 'fixture-only-ark-1234', defaultModel: 'ep-fixture', idempotencyKey: 'ark-provider-create-001',
  } });
  expect(created.statusCode).toBe(200);
  const { provider } = created.json();
  expect(provider).toMatchObject({ kind: 'VOLCENGINE_ARK', baseUrl: 'https://8.8.8.8/api/v3',
    capabilities: ['IMAGE'], defaultModel: 'ep-fixture', apiKeyLast4: '1234' });
  expect(Object.keys(provider)).not.toContain('encryptedSecrets');
  expect((await mock.app.inject(url)).json().items).toContainEqual(provider);
  const probed = await mock.app.inject({ method: 'POST', url: `${url}/${provider.id}/test` });
  expect(probed.json()).toMatchObject({ ok: true, models: ['doubao-seedream-fixture'], modelCount: 1 });
});

test('receives official Ark layers as inline PNGs and sends URL output and point guidance for edits', async () => {
  const common = { enabled: true, maxMegapixels: 2, maxLayers: 32 };
  const save = (mode: 'split' | 'edit', config: object) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/' + mode, payload: { config },
  });
  const run = (payload: object) => mock.app.inject({
    method: 'POST', url: '/v1/ai/canvas-layers', payload: { image: mock.paths.poster, ...payload },
  });
  const ark = { ...common, endpoint: '/images/generations', adapter: 'volcengine-ark' };
  expect((await save('split', { ...ark, creditsPerRequest: '12' })).statusCode).toBe(200);
  expect((await save('edit', { ...ark, creditsPerRequest: '8' })).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const invalid = await run({ operation: 'split', clientRequestId: 'ark-split-too-small', expectedCredits: '12' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_source_image' });
    const missing = await mock.app.inject('/v1/ai/canvas-layers/by-request/ark-split-too-small');
    expect(missing.statusCode).toBe(404);
    const largerPoster = await sharp(Buffer.from(mock.paths.poster.split(',')[1]!, 'base64')).resize(640, 800).png().toBuffer();
    const image = 'data:image/png;base64,' + largerPoster.toString('base64');
    const splitPayload = { operation: 'split', image, clientRequestId: 'ark-split-001', expectedCredits: '12' };
    const submissionsBefore = mock.upstreamCalls().length;
    const readsBefore = mock.arkLayerReads();
    const walletBefore = (await mock.app.inject('/fixture/receipt')).json();
    const splitResponse = await run(splitPayload);
    expect(splitResponse.statusCode).toBe(200);
    const split = splitResponse.json();
    expect(split).toMatchObject({ status: 'success', chargedCredits: '12.000000', result: { width: 320, height: 400,
      base: { asset: 0, width: 320, height: 400 },
      layers: [
        { name: '标题', asset: 1, order: 0, x: 27, y: 37, width: 210, height: 76, alpha: true, transparent: true },
        { name: '云朵', asset: 2, order: 1, x: 100, y: 175, width: 96, height: 56, alpha: true, transparent: true },
      ] } });
    expect(split.result.assets).toHaveLength(3);
    const expectedAssets = [
      { width: 320, height: 400, opaque: true },
      { width: 210, height: 76, opaque: false },
      { width: 96, height: 56, opaque: false },
    ];
    for (const [index, { width, height, opaque }] of expectedAssets.entries()) {
      const asset = await mock.app.inject(new URL(split.result.assets[index]).pathname);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toBe('image/png');
      const png = sharp(asset.rawPayload);
      expect(await png.metadata()).toMatchObject({ format: 'png', width, height, ...(opaque ? {} : { hasAlpha: true }) });
      expect((await png.stats()).isOpaque).toBe(opaque);
    }
    expect((await run(splitPayload)).json()).toEqual(split);
    const [submission] = mock.upstreamCalls().slice(submissionsBefore);
    expect(mock.upstreamCalls()).toHaveLength(submissionsBefore + 1);
    expect(submission).toMatchObject({ method: 'POST', url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      customTransport: true, arkClientRequestId: expect.stringMatching(/^[a-zA-Z0-9-]+$/),
      body: { image, layer_decomposition: true, response_format: 'b64_json' },
    });
    expect(submission?.body).not.toHaveProperty('prompt');
    expect(submission?.body).not.toHaveProperty('layer_decomposition_options');
    expect(mock.arkLayerReads()).toEqual(readsBefore);
    const walletAfter = (await mock.app.inject('/fixture/receipt')).json();
    expect(walletAfter.reservations).toBe(walletBefore.reservations);
    expect(walletAfter.ledger.slice(walletBefore.ledger.length))
      .toEqual([{ type: 'RESERVE', amount: '-12' }, { type: 'CHARGE', amount: '12' }]);

    const edit = (await run({ operation: 'edit', clientRequestId: 'ark-edit-001', expectedCredits: '8', prompt: '调整颜色',
      selection: { kind: 'point', x: 0.25, y: 0.5 } })).json();
    expect(edit).toMatchObject({ status: 'success', chargedCredits: '8.000000',
      result: { operation: 'edit', image: { width: 320, height: 400 } } });
    const sent = mock.upstreamCalls().at(-1)?.body;
    expect(sent?.prompt).toContain('图1<point>250 500</point>');
    expect(sent?.image).toBe(mock.paths.poster);
    expect(sent?.response_format).toBe('url');
    expect(sent).not.toHaveProperty('n');

    const beforeTimeout = mock.upstreamCalls().length;
    const timedOut = await run({ operation: 'edit', clientRequestId: 'ark-timeout-001', expectedCredits: '8', prompt: 'ark-timeout-fixture' });
    expect(timedOut.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000',
      message: '等待上游渠道响应超时。预留积分已释放。' });
    expect(mock.upstreamCalls()).toHaveLength(beforeTimeout + 1);

    const rejected = await run({ operation: 'edit', clientRequestId: 'ark-image-download-timeout-001', expectedCredits: '8',
      prompt: 'ark-image-download-timeout-fixture' });
    expect(rejected.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000',
      message: '方舟处理参考图超时（HTTP 400）。预留积分已释放。' });
    expect(mock.failureDiagnostic('ark-image-download-timeout-001')).toMatchObject({
      httpStatus: 400, ark: { code: 'InvalidParameter', parameter: 'image' },
    });
    expect(mock.upstreamCalls()).toHaveLength(beforeTimeout + 2);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('split', { ...common, endpoint: '/split', adapter: 'canvas-json', creditsPerRequest: '12' });
    await save('edit', { ...common, endpoint: '/edit', adapter: 'canvas-json', creditsPerRequest: '8' });
  }
}, 15_000);

test('rejects an oversized inline Ark split response and releases its reservation', async () => {
  const save = (endpoint: string, adapter: string, creditsPerRequest: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint, adapter, creditsPerRequest } },
  });
  expect((await save('/images/generations', 'volcengine-ark', '1')).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const clientRequestId = 'ark-split-oversized-inline';
    const before = (await mock.app.inject('/fixture/receipt')).json();
    const submissionsBefore = mock.upstreamCalls().length;
    const readsBefore = mock.arkLayerReads();
    const submit = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'split', image: mock.paths.splitPoster, clientRequestId,
      prompt: 'ark-oversized-inline-output-fixture', expectedCredits: '1',
    } });
    const response = await submit();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000',
      message: '方舟返回的图层数据超过服务端接收上限。预留积分已释放。' });
    expect(mock.failureDiagnostic(clientRequestId)).toMatchObject({ stage: 'canvas_layer_submit', code: 'IMAGE_SIZE_LIMIT' });
    expect((await submit()).json()).toEqual(response.json());
    expect(mock.upstreamCalls()).toHaveLength(submissionsBefore + 1);
    expect(mock.upstreamCalls().at(-1)).toMatchObject({ method: 'POST', body: { response_format: 'b64_json' } });
    expect(mock.arkLayerReads()).toEqual(readsBefore);
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.balance).toBe(before.balance);
    expect(after.reservations).toBe(before.reservations);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-1' }, { type: 'RELEASE', amount: '1' }]);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json', '12');
  }
}, 15_000);

test.each(['png', 'jpeg'] as const)('sends an owned Ark %s split source inline without requesting a private COS URL', async format => {
  const { splitPoster, splitSourceKey, splitJpeg, splitJpegKey } = mock.paths;
  const objectKey = format === 'png' ? splitSourceKey : splitJpegKey;
  const bytes = format === 'png' ? Buffer.from(splitPoster.split(',')[1]!, 'base64') : splitJpeg;
  const contentType = `image/${format}`;
  const head = vi.spyOn(storageService, 'headObject').mockResolvedValue({
    objectKey, contentLength: bytes.length, contentType, metadata: {}, headers: {},
  });
  const privateUrl = `https://cos.internal.example.test/${objectKey}?signed=fixture-only`;
  const downloadUrl = vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(privateUrl);
  const read = vi.spyOn(storageService, 'getObjectStream').mockImplementation(async () => ({
    stream: Readable.from([bytes]), statusCode: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
  }));
  const save = (endpoint: string, adapter: string, creditsPerRequest: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint, adapter, creditsPerRequest } },
  });
  const submit = (clientRequestId: string) => mock.app.inject({
    method: 'POST', url: '/v1/ai/canvas-layers',
    payload: { operation: 'split', image: objectKey, clientRequestId, expectedCredits: '1' },
  });
  try {
    expect((await save('/images/generations', 'volcengine-ark', '1')).statusCode).toBe(200);
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    const beforeCalls = mock.upstreamCalls().length;
    const requestId = `ark-split-inline-${format}`;
    const accepted = await submit(requestId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'success', chargedCredits: '1.000000' });
    expect(head).toHaveBeenCalledWith(objectKey);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(objectKey);
    expect(downloadUrl).not.toHaveBeenCalled();
    const image = String(mock.upstreamCalls().at(-1)?.body.image);
    expect(mock.upstreamCalls().at(-1)?.body).toMatchObject({ layer_decomposition: true });
    expect(image.startsWith(`data:${contentType};base64,`)).toBe(true);
    const sentBytes = Buffer.from(image.split(',')[1]!, 'base64');
    if (format === 'jpeg') {
      expect(bytes.length).toBeGreaterThan(512 * 1024);
      expect(sentBytes.length).toBeLessThan(bytes.length);
      const { width, height, orientation } = await sharp(bytes).metadata();
      expect(await sharp(sentBytes).metadata()).toMatchObject({ format, width, height });
      expect((await sharp(sentBytes).metadata()).orientation).toBe(orientation);
    } else {
      expect(sentBytes.equals(bytes)).toBe(true);
    }
    expect(accepted.body).not.toContain(image);
    expect((await submit(requestId)).json()).toEqual(accepted.json());
    expect(mock.upstreamCalls()).toHaveLength(beforeCalls + 1);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [head, downloadUrl, read]) spy.mockRestore();
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json', '12');
  }
}, 15_000);

test('retries one transient Ark layer download without resubmitting or charging twice', async () => {
  const save = (endpoint: string, adapter: string, creditsPerRequest: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint, adapter, creditsPerRequest } },
  });
  expect((await save('/images/generations', 'volcengine-ark', '1')).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const before = (await mock.app.inject('/fixture/receipt')).json();
    const readsBefore = mock.arkLayerReads().length;
    const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'split', clientRequestId: 'ark-split-retry-layer', image: mock.paths.splitPoster,
      prompt: 'ark-retry-layer-asset-fixture', expectedCredits: '1',
    } });
    const result = await post();
    expect(result.statusCode).toBe(200);
    const receipt = result.json();
    expect(receipt).toMatchObject({ status: 'success', chargedCredits: '1.000000', result: {
      width: 320, height: 400, base: { asset: 0, width: 320, height: 400 },
      layers: [
        { name: '标题', asset: 1, order: 0, x: 27, y: 37, width: 210, height: 76, alpha: true },
        { name: '云朵', asset: 2, order: 1, x: 100, y: 175, width: 96, height: 56, alpha: true },
      ],
    } });
    expect(receipt.result.assets).toHaveLength(3);
    for (const url of receipt.result.assets) {
      const asset = await mock.app.inject(new URL(url).pathname);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toBe('image/png');
    }
    expect((await post()).json()).toEqual(receipt);
    expect(mock.arkLayerReads().slice(readsBefore)).toEqual(['base', 'title', 'cloud', 'cloud']);
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect(after.reservations).toBe(before.reservations);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-1' }, { type: 'CHARGE', amount: '1' }]);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json', '12');
  }
}, 15_000);

test('recovers a deferred Ark split with a single worker claim and no new submission', async () => {
  const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
  const save = (endpoint: string, adapter: string, creditsPerRequest: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint, adapter, creditsPerRequest } },
  });
  expect((await save('/images/generations', 'volcengine-ark', '2')).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const clientRequestId = 'ark-split-recovery-layer';
    const before = (await mock.app.inject('/fixture/receipt')).json();
    const readsBefore = mock.arkLayerReads().length;
    const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'split', clientRequestId, image: mock.paths.splitPoster,
      prompt: 'ark-recover-layer-asset-fixture', expectedCredits: '2',
    } });
    const query = () => mock.app.inject('/v1/ai/canvas-layers/by-request/' + clientRequestId);
    const deferred = await post();
    expect(deferred.statusCode).toBe(202);
    expect(deferred.json()).toMatchObject({ status: 'processing', chargedCredits: '0.000000' });
    expect(deferred.body).not.toContain('signature=');
    expect((await query()).json()).toEqual(deferred.json());
    expect((await post()).json()).toEqual(deferred.json());
    expect(mock.arkLayerReads().slice(readsBefore)).toEqual(['base', 'title', 'title']);
    const pending = (await mock.app.inject('/fixture/receipt')).json();
    expect(pending.calls).toHaveLength(before.calls.length + 1);
    expect(pending.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-2' }]);

    const dueAt = mock.arkDownloadDueAt(clientRequestId);
    expect(dueAt).toBeInstanceOf(Date);
    await expect(recoverNextArkCanvasLayerOutput(mock.app.prisma, new Date(dueAt!.getTime() - 1))).resolves.toBe(false);
    mock.allowArkRecoveryAssets();
    const recovered = await Promise.all([
      recoverNextArkCanvasLayerOutput(mock.app.prisma, dueAt!),
      recoverNextArkCanvasLayerOutput(mock.app.prisma, dueAt!),
    ]);
    expect(recovered.sort()).toEqual([false, true]);
    const receipt = (await query()).json();
    expect(receipt).toMatchObject({ status: 'success', chargedCredits: '2.000000', result: {
      width: 320, height: 400,
      layers: [
        { name: '标题', asset: 1, order: 0, x: 27, y: 37, width: 210, height: 76, alpha: true },
        { name: '云朵', asset: 2, order: 1, x: 100, y: 175, width: 96, height: 56, alpha: true },
      ],
    } });
    expect(receipt.result.assets).toHaveLength(3);
    expect(mock.arkLayerReads().slice(readsBefore)).toEqual(['base', 'title', 'title', 'base', 'title', 'cloud']);
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect(after.reservations).toBe(before.reservations);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-2' }, { type: 'CHARGE', amount: '2' }]);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json', '12');
  }
}, 15_000);

test.each([
  { reason: 'a permanent 403', prompt: 'ark-expired-layer-asset-fixture', deferred: false,
    clientRequestId: 'ark-split-expired-layer', reads: ['base', 'title', 'cloud'] },
  { reason: 'persistent transient failures', prompt: 'ark-exhausted-layer-asset-retry-fixture', deferred: true,
    clientRequestId: 'ark-split-exhausted-layer-retry', reads: ['base', 'base', 'title'] },
])('refunds a failed Ark split when $reason prevents downloading a layer', async ({ prompt, clientRequestId, reads, deferred }) => {
  const save = (endpoint: string, adapter: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint, adapter, creditsPerRequest: '12' } },
  });
  expect((await save('/images/generations', 'volcengine-ark')).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const before = (await mock.app.inject('/fixture/receipt')).json();
    const readsBefore = mock.arkLayerReads().length;
    const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'split', clientRequestId, image: mock.paths.splitPoster, prompt, expectedCredits: '12',
    } });
    let result = await post();
    expect(result.statusCode).toBe(deferred ? 202 : 200);
    expect(mock.arkLayerReads().slice(readsBefore)).toEqual(reads);
    if (deferred) {
      const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
      expect(result.json()).toMatchObject({ status: 'processing' });
      const dueAt = mock.arkDownloadDueAt(clientRequestId);
      expect(dueAt).toBeInstanceOf(Date);
      await expect(recoverNextArkCanvasLayerOutput(mock.app.prisma, dueAt!)).resolves.toBe(true);
      result = await mock.app.inject('/v1/ai/canvas-layers/by-request/' + clientRequestId);
      expect(mock.arkLayerReads().slice(readsBefore)).toEqual([...reads, 'base', 'title', 'title']);
    }
    expect(result.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000',
      message: '上游返回了图片地址，但下载失败。预留积分已释放。' });
    expect(mock.failureDiagnostic(clientRequestId)).toMatchObject({ stage: 'canvas_layer_download' });
    expect((await post()).json()).toEqual(result.json());
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect(after.balance).toBe(before.balance);
    expect(after.reservations).toBe(before.reservations);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-12' }, { type: 'RELEASE', amount: '12' }]);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json');
  }
}, 15_000);

test('records safe Ark split rejection diagnostics and releases credits without re-submitting', async () => {
  const route = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split';
  const common = { enabled: true, maxMegapixels: 2, maxLayers: 32, creditsPerRequest: '12' };
  const save = (endpoint: string, adapter: string) => mock.app.inject({
    method: 'PUT', url: route, payload: { config: { ...common, endpoint, adapter } },
  });
  expect((await save('/images/generations', 'volcengine-ark')).statusCode).toBe(200);
  mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
  try {
    const posterBytes = Buffer.from(mock.paths.poster.split(',')[1]!, 'base64');
    const image = 'data:image/png;base64,' + (await sharp(posterBytes).resize(640, 800).png().toBuffer()).toString('base64');
    const clientRequestId = 'ark-split-unsupported-parameter';
    const payload = { operation: 'split', image, clientRequestId, expectedCredits: '12', prompt: 'ark-unsupported-parameter-fixture' };
    const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload });
    const before = (await mock.app.inject('/fixture/receipt')).json();

    const rejected = await post();
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000' });
    const diagnostic = mock.failureDiagnostic(clientRequestId);
    expect(diagnostic).toMatchObject({
      stage: 'canvas_layer_submit', httpStatus: 400,
      ark: { code: 'InvalidParameter.UnsupportedParameter', parameter: 'layer_decomposition' },
    });
    const restored = readFailureDiagnostic(diagnostic);
    expect(restored).toEqual(diagnostic);
    expect(readFailureDiagnostic({ ...restored, ark: {
      code: 'InvalidParameter.UnsupportedParameter', parameter: 'https://example.test/fake-secret',
    } })?.ark).toEqual({ code: 'InvalidParameter.UnsupportedParameter' });
    expect(readFailureDiagnostic({ ...restored, ark: {
      code: 'InvalidParameter.fake-secret', parameter: 'layer_decomposition',
    } })?.ark).toEqual({ parameter: 'layer_decomposition' });
    for (const output of [JSON.stringify(diagnostic), rejected.body]) {
      expect(output).not.toContain('fake-secret');
      expect(output).not.toContain('https://example.test');
      expect(output).not.toContain('fixture-secret');
    }

    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.balance).toBe(before.balance);
    expect(after.reservations).toBe(before.reservations);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-12' }, { type: 'RELEASE', amount: '12' }]);
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect((await post()).json()).toEqual(rejected.json());
    expect((await mock.app.inject('/fixture/receipt')).json()).toEqual(after);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/split', 'canvas-json');
  }
}, 15_000);

test('sends Ark split options only for identified Seedream 5.5 and clamps edit coordinates', async () => {
  const { layerUpstreamBody } = await import('../src/modules/ai/layer-canvas-adapters.js');
  const source = { width: 320, height: 400, alpha: false };
  const split = { operation: 'split', image: mock.paths.poster, prompt: '只拆云朵', clientRequestId: 'ark-settings-test' } as const;
  const settings = { maxLayers: 32, canonicalModelKey: 'local-layer-model' };
  const build = (model: string, canonicalModelKey = settings.canonicalModelKey) => layerUpstreamBody(
    'volcengine-ark', split, model, source, { ...settings, canonicalModelKey },
  );
  await expect(build('doubao-seedream-5-5-261028')).resolves.toMatchObject({
    prompt: '只拆云朵', layer_decomposition_options: { max_images: 33 },
  });
  await expect(build('ep-known-5-5', 'seedream-5-5')).resolves.toHaveProperty('layer_decomposition_options.max_images', 33);
  await expect(build('doubao-seedream-5-0-flash-260915', 'seedream-5-5')).resolves.not.toHaveProperty('layer_decomposition_options');
  await expect(build('ep-unknown')).resolves.not.toHaveProperty('layer_decomposition_options');
  await expect(build('doubao-seedream-5-0-flash-260915')).resolves.toMatchObject({
    layer_decomposition: true, image: mock.paths.poster,
  });
  const edge = await layerUpstreamBody('volcengine-ark', { ...split, operation: 'edit',
    selection: { kind: 'rect', x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 },
  }, 'doubao-seedream-5-0-flash-260915', source, settings);
  expect(edge).toMatchObject({ image: mock.paths.poster, prompt: expect.stringContaining('图1<bbox>998 998 999 999</bbox>') });
});

test('delivers USELG synchronous or asynchronous edit images with one submission per request', async () => {
  const common = { enabled: true, maxMegapixels: 2, maxLayers: 1, creditsPerRequest: '8', adapter: 'canvas-json' };
  const save = (endpoint: string) => mock.app.inject({
    method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/edit',
    payload: { config: { ...common, endpoint } },
  });
  const submit = (clientRequestId: string, prompt: string) => mock.app.inject({
    method: 'POST', url: '/v1/ai/canvas-layers',
    payload: { operation: 'edit', clientRequestId, prompt, expectedCredits: '8', image: mock.paths.poster },
  });
  expect((await save('/v1/images/edits')).statusCode).toBe(200);
  mock.useMockAProviderKind('USELG');
  try {
    const initialSubmissions = mock.upstreamCalls().length;
    const initialReads = mock.uselgReads().length;
    const [first, duplicate] = await Promise.all([
      submit('uselg-layer-async-fixture', 'task receipt'),
      submit('uselg-layer-async-fixture', 'task receipt'),
    ]);
    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([200, 202]);
    const completed = (first.statusCode === 200 ? first : duplicate).json();
    expect(completed).toMatchObject({ status: 'success', chargedCredits: '8.000000',
      result: { operation: 'edit', image: { width: 320, height: 400 } } });
    const asset = await mock.app.inject(new URL(completed.result.assets[0]).pathname);
    expect(asset.statusCode).toBe(200);
    expect(await sharp(asset.rawPayload).metadata()).toMatchObject({ width: 320, height: 400 });
    expect(mock.uselgReads().slice(initialReads)).toEqual([
      '/v1/images/tasks/imgtask-layer-edit-fixture?view=summary',
      '/v1/images/tasks/imgtask-layer-edit-fixture',
      '/v1/images/tasks/imgtask-layer-edit-fixture/assets/0',
    ]);
    expect((await submit('uselg-layer-async-fixture', 'task receipt')).json()).toEqual(completed);
    expect(mock.upstreamCalls().length).toBe(initialSubmissions + 1);

    expect((await submit('uselg-layer-direct-fixture', 'direct asset')).json()).toMatchObject({
      status: 'success', chargedCredits: '8.000000', result: { operation: 'edit', assets: [expect.any(String)] },
    });
    expect(mock.uselgReads().at(-1)).toBe('/v1/images/tasks/direct/assets/0');

    expect((await submit('uselg-layer-signed-fixture', 'signed asset')).json()).toMatchObject({
      status: 'success', chargedCredits: '8.000000', result: { operation: 'edit', assets: [expect.any(String)] },
    });
    expect(mock.uselgReads().at(-1)).toBe('https://9.9.9.9/canvas-edit.png');

    expect((await submit('uselg-layer-expired-fixture', 'expired asset')).json()).toMatchObject({
      status: 'failed', chargedCredits: '0.000000', message: '上游返回了图片地址，但下载失败。预留积分已释放。',
    });
    expect(mock.failureDiagnostic('uselg-layer-expired-fixture')).toMatchObject({
      stage: 'canvas_layer_download', code: 'PROVIDER_AUTH_FAILED', httpStatus: 403,
    });
    expect(mock.upstreamCalls().length).toBe(initialSubmissions + 4);
  } finally {
    mock.useMockAProviderKind('NEW_API');
    await save('/edit');
  }
}, 20_000);

test('allows hidden images only for the layer tasks they are explicitly assigned to', async () => {
  const modelKey = 'local-layer-model';
  const admin = '/v1/admin/ai-models';
  const setVisibility = (visible: boolean) => mock.app.inject({
    method: 'PATCH', url: `${admin}/${modelKey}`, payload: { visible },
  });
  const getCatalog = async () => (await mock.app.inject('/v1/ai/catalog')).json();

  expect((await setVisibility(false)).statusCode).toBe(200);
  try {
    const settings = (await mock.app.inject(`${admin}/layer-tasks`)).json();
    expect(settings.models).toEqual([expect.objectContaining({ canonicalModelKey: modelKey })]);
    expect((await getCatalog()).canvasLayers.split).toEqual([]);

    for (const { mode, endpoint, creditsPerRequest } of [
      { mode: 'split', endpoint: '/split', creditsPerRequest: '1' },
      { mode: 'edit', endpoint: '/edit', creditsPerRequest: '2' },
    ] as const) {
      const saved = await mock.app.inject({
        method: 'PUT', url: `${admin}/layer-tasks/${mode}`, payload: {
          modelKey, routeId: 'mock-a', config: {
            enabled: true, endpoint, adapter: 'canvas-json', creditsPerRequest, maxMegapixels: 2, maxLayers: mode === 'split' ? 24 : 1,
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      const result = await mock.app.inject({
        method: 'POST', url: '/v1/ai/canvas-layers', payload: {
          clientRequestId: `hidden-layer-${mode}`, operation: mode, image: mock.paths.poster,
          prompt: 'Color', expectedCredits: creditsPerRequest,
        },
      });
      expect(result.json()).toMatchObject({ status: 'success', model: modelKey, chargedCredits: `${creditsPerRequest}.000000` });
    }

    const catalog = await getCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.canvasLayers).toMatchObject({ split: [{ id: modelKey }], edit: [{ id: modelKey }] });
    const upstreamCalls = mock.upstreamCalls().length;
    for (const model of [modelKey, 'local-layer-alias']) {
      for (const path of ['generations', 'operations']) {
        const response = await mock.app.inject({
          method: 'POST', url: `/v1/ai/images/${path}`, payload: {
            clientRequestId: `hidden-${model}-${path}`, model, prompt: 'A poster',
            ...(path === 'operations' ? { operation: 'imagine' } : {}),
          },
        });
        expect(response.statusCode, `${path} (${model}): ${response.body}`).toBe(409);
        expect(response.json()).toMatchObject({ error: 'MODEL_NOT_AVAILABLE' });
      }
    }
    expect(mock.upstreamCalls()).toHaveLength(upstreamCalls);
  } finally {
    await setVisibility(true);
  }
});

test('uses an owned reference key for canvas layer input and deduplicates retries', async () => {
  const { sourceKey: objectKey, alphaPoster, arkEditSourceUrl, splitJpegKey, splitJpeg } = mock.paths;
  const foreignKey = 'reference-images/foreign-layer-test-source.png';
  const posterBytes = Buffer.from(alphaPoster.split(',')[1]!, 'base64');
  const head = vi.spyOn(storageService, 'headObject').mockResolvedValue({
    objectKey, contentLength: posterBytes.length, contentType: 'image/png', metadata: {}, headers: {},
  });
  const signedUrl = arkEditSourceUrl(objectKey);
  const downloadUrl = vi.spyOn(storageService, 'getDownloadUrl').mockReturnValue(signedUrl);
  const validateSigned = vi.spyOn(storageService, 'validateSignedUrl').mockReturnValue(signedUrl);
  const read = vi.spyOn(storageService, 'getObjectStream').mockImplementation(async () => ({
    stream: Readable.from([posterBytes]), statusCode: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(posterBytes.length) },
  }));
  try {
    const catalog = (await mock.app.inject('/v1/ai/catalog')).json().canvasLayers;
    expect(catalog.referenceUpload).toBe(true);
    const credits = catalog.edit[0].creditsPerRequest;
    const submit = (image: string, clientRequestId: string, prompt = 'Color', expectedCredits = credits) => mock.app.inject({
      method: 'POST', url: '/v1/ai/canvas-layers', payload: { operation: 'edit', clientRequestId,
        prompt, image, expectedCredits },
    });
    const upstreamCalls = mock.upstreamCalls().length;
    const denied = await submit(foreignKey, 'foreign-reference-001');
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: 'invalid_reference_image' });
    expect(head).not.toHaveBeenCalled();
    expect(mock.upstreamCalls()).toHaveLength(upstreamCalls);

    const accepted = await submit(objectKey, 'owned-reference-001');
    expect(accepted.json()).toMatchObject({ status: 'success', chargedCredits: credits });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(objectKey);
    expect(mock.upstreamCalls().at(-1)?.body.image).toEqual(alphaPoster);
    expect(downloadUrl).not.toHaveBeenCalled();
    expect((await submit(objectKey, 'owned-reference-001')).json()).toEqual(accepted.json());
    expect(read).toHaveBeenCalledTimes(1);
    expect(mock.upstreamCalls()).toHaveLength(upstreamCalls + 1);

    const common = { enabled: true, maxMegapixels: 2, maxLayers: 32, creditsPerRequest: credits };
    const save = (endpoint: string, adapter: string, creditsPerRequest = credits) => mock.app.inject({ method: 'PUT',
      url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/edit', payload: { config: { ...common, endpoint, adapter, creditsPerRequest } },
    });
    expect((await save('/images/generations', 'volcengine-ark', '1')).statusCode).toBe(200);
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    try {
      head.mockClear();
      expect((await submit(foreignKey, 'foreign-reference-ark-001', 'Color', '1')).statusCode).toBe(400);
      expect(head).not.toHaveBeenCalled();
      expect(downloadUrl).not.toHaveBeenCalled();
      expect(mock.upstreamCalls()).toHaveLength(upstreamCalls + 1);
      const official = await submit(objectKey, 'owned-reference-ark-001', 'Color', '1');
      expect(official.json()).toMatchObject({ status: 'success', chargedCredits: '1.000000',
        result: { operation: 'edit', image: { width: 320, height: 400 } } });
      expect(downloadUrl).toHaveBeenCalledWith(objectKey, { expiresSeconds: 600 });
      expect(validateSigned).toHaveBeenCalledWith(objectKey, signedUrl);
      expect(read).toHaveBeenLastCalledWith(objectKey);
      const upstream = mock.upstreamCalls().at(-1);
      expect(upstream).toMatchObject({ arkClientRequestId: expect.any(String), body: { image: signedUrl, background: 'transparent' } });
      expect((await sharp(posterBytes).stats()).isOpaque).toBe(false);
      expect(official.body).not.toContain(signedUrl);
      expect((await submit(objectKey, 'owned-reference-ark-001', 'Color', '1')).json()).toEqual(official.json());
      expect(read).toHaveBeenCalledTimes(2);
      expect(mock.upstreamCalls()).toHaveLength(upstreamCalls + 2);

      const rejected = () => submit(objectKey, 'owned-reference-ark-rejected', 'ark-image-download-timeout-fixture', '1');
      const rejectedReceipt = (await rejected()).json();
      expect(rejectedReceipt).toMatchObject({ status: 'failed', chargedCredits: '0.000000' });
      expect(mock.upstreamCalls().at(-1)?.body.image).toBe(signedUrl);
      expect((await rejected()).json()).toEqual(rejectedReceipt);
      expect(mock.upstreamCalls()).toHaveLength(upstreamCalls + 3);

      downloadUrl.mockReturnValueOnce(`https://canvas-reference-fixture.oss-cn-beijing-internal.aliyuncs.com/${splitJpegKey}?signed=fixture-only`);
      head.mockResolvedValueOnce({
        objectKey: splitJpegKey, contentLength: splitJpeg.length, contentType: 'image/jpeg', metadata: {}, headers: {},
      });
      read.mockResolvedValueOnce({ stream: Readable.from([splitJpeg]), statusCode: 200, headers: { 'content-type': 'image/jpeg' } });
      const fallback = await submit(splitJpegKey, 'owned-reference-ark-private', 'Color', '1');
      expect(fallback.json()).toMatchObject({ status: 'success', chargedCredits: '1.000000' });
      expect(downloadUrl).toHaveBeenCalledWith(splitJpegKey, { expiresSeconds: 600 });
      expect(validateSigned).toHaveBeenCalledTimes(2);
      expect(mock.upstreamCalls().at(-1)?.body.image).toBe('data:image/jpeg;base64,' + splitJpeg.toString('base64'));
      expect(mock.upstreamCalls()).toHaveLength(upstreamCalls + 4);
    } finally {
      mock.useMockAProviderKind('NEW_API');
      await save('/edit', 'canvas-json');
    }
  } finally {
    for (const spy of [head, downloadUrl, validateSigned, read]) spy.mockRestore();
  }
}, 15_000);
