import { afterAll, beforeAll, expect, test } from 'vitest';
import sharp from 'sharp';
import { startLayerMock } from './fixtures/layer-canvas-mock.js';

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

test('routes Ark split and edit, positions cropped layers, and only draws guidance on the upstream copy', async () => {
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
  try {
    const split = (await run({ operation: 'split', clientRequestId: 'ark-split-001', expectedCredits: '12' })).json();
    expect(split).toMatchObject({ status: 'success', chargedCredits: '12.000000', result: { width: 320, height: 400,
      layers: [
        { name: '标题', order: 0, x: 27, y: 37, width: 210, height: 76 },
        { name: '云朵', order: 1, x: 100, y: 175, width: 96, height: 56, alpha: true, transparent: true },
      ] } });
    expect(mock.upstreamCalls().at(-1)?.body).toMatchObject({ image: mock.paths.poster, layer_decomposition: true, response_format: 'url' });
    const layer = await mock.app.inject(new URL(split.result.assets[2]).pathname);
    expect(await sharp(layer.rawPayload).metadata()).toMatchObject({ width: 96, height: 56, hasAlpha: true });

    const edit = (await run({ operation: 'edit', clientRequestId: 'ark-edit-001', expectedCredits: '8', prompt: '调整颜色',
      selection: { kind: 'point', x: 0.25, y: 0.5 } })).json();
    expect(edit).toMatchObject({ status: 'success', chargedCredits: '8.000000',
      result: { operation: 'edit', image: { width: 320, height: 400 } } });
    const sent = mock.upstreamCalls().at(-1)?.body;
    expect(sent?.prompt).toContain('红色标记点');
    const marker = await sharp(Buffer.from(String(sent?.image).split(',')[1]!, 'base64'))
      .extract({ left: 80, top: 200, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect([...marker]).toEqual([255, 48, 80]);
    expect(sent).not.toHaveProperty('n');
  } finally {
    await save('split', { ...common, endpoint: '/split', adapter: 'canvas-json', creditsPerRequest: '12' });
    await save('edit', { ...common, endpoint: '/edit', adapter: 'canvas-json', creditsPerRequest: '8' });
  }
}, 15_000);
