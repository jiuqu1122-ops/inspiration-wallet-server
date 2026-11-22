import { expect, test, vi } from 'vitest';
import { startLayerMock } from './fixtures/layer-canvas-mock.js';
import { storageService } from '../src/modules/storage/service.js';
import { createImageResultFromResponse } from '../src/modules/ai/image-result-store.js';

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
