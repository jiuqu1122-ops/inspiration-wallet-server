import { expect, test, vi } from 'vitest';
import { startLayerMock } from './fixtures/layer-canvas-mock.js';

test('keeps the base saved on the third pass and gives the next layer its own retries', async () => {
  const mock = await startLayerMock(0);
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
    const readsAtThirdPass = [...Array<string>(5).fill('base.png'), 'title.png', 'title.png'];
    expect(attempts).toEqual(readsAtThirdPass);
    const receipt = (await processNext()).json();
    expect(receipt).toMatchObject({ status: 'success', chargedCredits: '12.000000' });
    expect(receipt.result.assets).toHaveLength(3);
    expect(attempts).toEqual([...readsAtThirdPass, 'title.png', 'cloud.png']);
    expect((await post()).json()).toEqual(receipt);
    const after = (await mock.app.inject('/fixture/receipt')).json();
    expect(after.calls).toHaveLength(before.calls.length + 1);
    expect(after.ledger.slice(before.ledger.length)).toEqual([{ type: 'RESERVE', amount: '-12' }, { type: 'CHARGE', amount: '12' }]);
  } finally {
    spy.mockRestore();
    await mock.close();
  }
}, 15_000);
