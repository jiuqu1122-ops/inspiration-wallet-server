import { expect, test, vi } from 'vitest';
import { startLayerMock } from './fixtures/layer-canvas-mock.js';
import { storageService } from '../src/modules/storage/service.js';
import { createImageResultFromResponse } from '../src/modules/ai/image-result-store.js';

test('bills the base and fourteen delivered layers once at their submitted price after recovery', async () => {
  const mock = await startLayerMock(0);
  const uploads = vi.spyOn(storageService, 'uploadMedia').mockImplementation(async ({ namespace, filename }) => namespace + '/' + filename)
    .mockRejectedValueOnce(new Error('COS temporarily unavailable'));
  const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
  const clientRequestId = 'split-fifteen-priced-outputs';
  const adminPath = '/v1/admin/ai-models/layer-tasks';
  const configure = (mode: string, unit: string) => mock.app.inject({ method: 'PUT', url: adminPath + '/' + mode,
    payload: { modelKey: 'local-layer-model', routeId: 'mock-a', config: { enabled: true, endpoint: '/images/generations',
      adapter: 'volcengine-ark', maxLayers: 32, maxMegapixels: 2, creditsPerOutputImage: unit } } });
  const post = (quote: object) => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers',
    payload: { clientRequestId, operation: 'split', image: mock.paths.splitPoster, prompt: 'fourteen foreground layers', ...quote } });
  const quoted = { expectedCredits: '21.25', expectedCreditsPerOutputImage: '1.25' };
  const ledger = async () => (await mock.app.inject('/fixture/receipt')).json();
  try {
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    await mock.app.prisma.aiModelRoute.update({ where: { id: 'mock-a' }, data: { upstreamModelId: 'doubao-seedream-5-0-flash-260915' } });
    expect((await configure('edit', '1.25')).statusCode).toBe(400);
    expect((await configure('split', '1.25')).statusCode).toBe(200);
    const catalog = (await mock.app.inject('/v1/ai/catalog')).json().canvasLayers;
    expect(catalog.split[0]).toMatchObject({ creditsPerOutputImage: '1.250000', maxOutputImages: 17, maxCredits: '21.250000' });
    expect(catalog.edit[0].creditsPerRequest).toBe('8.000000');
    for (const stale of [{}, { ...quoted, expectedCredits: '20' }, { ...quoted, expectedCreditsPerOutputImage: '2' }]) {
      expect((await post(stale)).statusCode).toBe(409);
    }
    expect((await ledger()).ledger).toEqual([]);
    expect((await post(quoted)).statusCode).toBe(202);
    expect((await configure('split', '4')).statusCode).toBe(200);
    const work = () => recoverNextArkCanvasLayerOutput(mock.app.prisma, mock.arkDownloadDueAt(clientRequestId)!);
    expect(await work()).toBe(true);
    expect((await ledger()).ledger).toEqual([{ type: 'RESERVE', amount: '-21.25' }]);
    expect(await work()).toBe(true);
    const receipt = (await post(quoted)).json();
    expect(receipt).toMatchObject({ status: 'success', chargedCredits: '18.750000',
      imageBilling: { imageCount: 15, creditsPerOutputImage: '1.250000' } });
    expect(receipt.result.assets).toHaveLength(15);
    expect((await mock.app.inject('/v1/ai/canvas-layers/by-request/' + clientRequestId)).json()).toEqual(receipt);
    const row = await mock.app.prisma.aiRequest.findUnique({ where: { userId_clientRequestId: { userId: 'local-test-user', clientRequestId } } });
    expect(row?.chargeBreakdown).toMatchObject({ baseImageCount: 1, layerCount: 14, imageCount: 15,
      creditsPerOutputImage: '1.250000', reservedCredits: '21.250000', totalCredits: '18.750000' });
    expect(await ledger()).toMatchObject({ balance: '81.25', reservations: '0', ledger: [
      { type: 'RESERVE', amount: '-21.25' }, { type: 'CHARGE', amount: '18.75' }, { type: 'RELEASE', amount: '2.5' },
    ] });
  } finally {
    uploads.mockRestore();
    await mock.close();
  }
}, 15_000);

test('releases the entire per-image reserve when the last layer fails after two uploads', async () => {
  const mock = await startLayerMock(0);
  const uploads = vi.spyOn(storageService, 'uploadMedia').mockImplementation(async ({ namespace, filename }) => namespace + '/' + filename);
  const clientRequestId = 'split-incomplete-price';
  const configure = (unit: string) => mock.app.inject({ method: 'PUT', url: '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split',
    payload: { config: { enabled: true, endpoint: '/images/generations', adapter: 'volcengine-ark', maxLayers: 3,
      maxMegapixels: 2, creditsPerOutputImage: unit } } });
  const post = (expectedCredits: string) => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers',
    payload: { clientRequestId, operation: 'split', image: mock.paths.splitPoster, prompt: 'ark-expired-layer-asset-fixture', expectedCredits } });
  try {
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    expect((await configure('30')).statusCode).toBe(200);
    expect((await post('120')).statusCode).toBe(402);
    expect(mock.upstreamCalls()).toHaveLength(0);
    expect((await configure('2.1')).statusCode).toBe(200);
    expect((await post('8.4')).statusCode).toBe(202);
    const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
    await recoverNextArkCanvasLayerOutput(mock.app.prisma, mock.arkDownloadDueAt(clientRequestId)!);
    expect(uploads).toHaveBeenCalledTimes(2);
    expect((await post('8.4')).json()).toMatchObject({ status: 'failed', chargedCredits: '0.000000' });
    expect((await mock.app.inject('/fixture/receipt')).json()).toMatchObject({ balance: '100', reservations: '0',
      ledger: [{ type: 'RESERVE', amount: '-8.4' }, { type: 'RELEASE', amount: '8.4' }] });
  } finally {
    uploads.mockRestore();
    await mock.close();
  }
}, 15_000);

test('gives storage and each new layer their own retry allowance after repeated base download failures', async () => {
  const mock = await startLayerMock(0);
  const uploads = vi.spyOn(storageService, 'uploadMedia').mockImplementation(async ({ namespace, filename }) => namespace + '/' + filename)
    .mockRejectedValueOnce(new Error('COS temporarily unavailable'));
  const downloads = await import('../src/modules/ai/seedream-references.js');
  const { ReferenceUploadError } = await import('../src/modules/ai/reference-upload-service.js');
  const original = downloads.downloadArkCanvasResultBytes;
  const attempts: string[] = [];
  let baseTimeouts = 4;
  let titleTimeouts = 2;
  const spy = vi.spyOn(downloads, 'downloadArkCanvasResultBytes').mockImplementation((url, signal, split) => {
    const layer = new URL(url).pathname.split('/').at(-1)!;
    attempts.push(layer);
    if ((layer === 'base.png' && baseTimeouts-- > 0) || (layer === 'title.png' && titleTimeouts-- > 0)) {
      return Promise.reject(new ReferenceUploadError('Asset timeout', 'ark_result_timeout', 504));
    }
    return original(url, signal, split);
  });
  const route = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split';
  const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
  const clientRequestId = 'ark-split-timeouts-on-successive-layers';
  try {
    const configured = await mock.app.inject({ method: 'PUT', url: route, payload: { config: { enabled: true,
      maxMegapixels: 2, maxLayers: 32, endpoint: '/images/generations', adapter: 'volcengine-ark', creditsPerRequest: '12' } } });
    expect(configured.statusCode).toBe(200);
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    const before = (await mock.app.inject('/fixture/receipt')).json();
    const post = () => mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers',
      payload: { operation: 'split', clientRequestId, image: mock.paths.splitPoster, expectedCredits: '12' } });
    expect((await post()).statusCode).toBe(202);
    const processNext = async () => {
      const due = mock.arkDownloadDueAt(clientRequestId);
      expect(due).toBeInstanceOf(Date);
      expect(await recoverNextArkCanvasLayerOutput(mock.app.prisma, due!)).toBe(true);
      return mock.app.inject('/v1/ai/canvas-layers/by-request/' + clientRequestId);
    };
    for (let pass = 0; pass < 3; pass++) {
      expect((await processNext()).json()).toMatchObject({ status: 'processing' });
    }
    expect(attempts).toEqual(Array<string>(5).fill('base.png'));
    expect((await processNext()).json()).toMatchObject({ status: 'processing' });
    const readsBeforeLastPass = [...Array<string>(5).fill('base.png'), 'title.png', 'title.png'];
    expect(attempts).toEqual(readsBeforeLastPass);
    const receipt = (await processNext()).json();
    expect(receipt).toMatchObject({ status: 'success', chargedCredits: '12.000000' });
    expect(receipt.result.assets).toHaveLength(3);
    expect(attempts).toEqual([...readsBeforeLastPass, 'title.png', 'cloud.png']);
    expect(uploads.mock.calls[0]![0].filename).toBe(uploads.mock.calls[1]![0].filename);
    expect((await post()).json()).toEqual(receipt);
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-12' }, { type: 'CHARGE', amount: '12' }]);
  } finally {
    spy.mockRestore();
    await mock.close();
  }
}, 15_000);

test('adopts a split started by an older worker and uploads its saved base without another upstream read', async () => {
  const mock = await startLayerMock(0);
  const uploads = vi.spyOn(storageService, 'uploadMedia').mockImplementation(async ({ namespace, filename }) => namespace + '/' + filename);
  const clientRequestId = 'ark-split-legacy-local-base';
  try {
    const route = '/v1/admin/ai-models/local-layer-model/layer-routes/mock-a/split';
    const config = { enabled: true, maxMegapixels: 2, maxLayers: 32, endpoint: '/images/generations', adapter: 'volcengine-ark', creditsPerRequest: '12' };
    expect((await mock.app.inject({ method: 'PUT', url: route, payload: { config } })).statusCode).toBe(200);
    mock.useMockAProviderKind('VOLCENGINE_ARK', 'https://ark.cn-beijing.volces.com/api/v3');
    const response = await mock.app.inject({ method: 'POST', url: '/v1/ai/canvas-layers', payload: {
      operation: 'split', image: mock.paths.splitPoster, expectedCredits: '12', clientRequestId,
    } });
    expect(response.statusCode).toBe(202);
    const where = { userId_clientRequestId: { userId: 'local-test-user', clientRequestId } };
    const row = await mock.app.prisma.aiRequest.findUnique({ where });
    const raw = await createImageResultFromResponse(new Response(Buffer.from(mock.paths.base.split(',')[1]!, 'base64')));
    const result = JSON.parse(JSON.stringify(row!.result));
    await mock.app.prisma.aiRequest.updateMany({ where: { id: row!.id }, data: { result: { ...result, arkDownloadedAssets: [raw] } } });
    const { recoverNextArkCanvasLayerOutput } = await import('../src/modules/ai/layer-canvas-service.js');
    expect(await recoverNextArkCanvasLayerOutput(mock.app.prisma, mock.arkDownloadDueAt(clientRequestId)!)).toBe(true);
    expect(mock.arkLayerReads()).toEqual(['title', 'cloud']);
    const receipt = await mock.app.inject('/v1/ai/canvas-layers/by-request/' + clientRequestId);
    expect(receipt.json()).toMatchObject({ status: 'success', chargedCredits: '12.000000' });
    expect(uploads).toHaveBeenCalledTimes(3);
    expect(receipt.json().result.assets[0]).toContain(uploads.mock.calls[0]![0].filename);
  } finally { await mock.close(); }
}, 15_000);
