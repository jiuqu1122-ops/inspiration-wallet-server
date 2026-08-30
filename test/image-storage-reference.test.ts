import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
  tryResolveObjectKeyFromUrl: vi.fn(),
  getObjectStream: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: dnsMocks.lookup,
}));
vi.mock('../src/modules/storage/service.js', () => ({
  storageService: storageMocks,
}));

import {
  materializeNewApiReferenceImage,
  stageXaisPublicReference,
} from '../src/modules/ai/image-service.js';

describe('internal object storage image references', () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
    storageMocks.tryResolveObjectKeyFromUrl.mockReset();
    storageMocks.getObjectStream.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses the Storage SDK path for an owned COS URL without consulting link-local DNS', async () => {
    const source = (
      'https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/'
      + 'reference-images/sdk-path.png?q-signature=signed'
    );
    const objectKey = 'reference-images/sdk-path.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    dnsMocks.lookup.mockResolvedValue([{ address: '169.254.0.47', family: 4 }]);
    storageMocks.tryResolveObjectKeyFromUrl.mockImplementation(
      (value: string) => value === source ? objectKey : null,
    );
    storageMocks.getObjectStream.mockResolvedValue({
      stream: Readable.from([png]),
      statusCode: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
      },
    });
    const fetchMock = vi.fn(() => {
      throw new Error('owned storage URLs must not use fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(storageMocks.getObjectStream).toHaveBeenCalledWith(objectKey);
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stages an owned COS reference file through the Storage SDK path', async () => {
    const source = (
      'https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/'
      + 'reference-images/xais-sdk-path.png?q-signature=signed'
    );
    const objectKey = 'reference-images/xais-sdk-path.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    dnsMocks.lookup.mockResolvedValue([{ address: '169.254.0.47', family: 4 }]);
    storageMocks.tryResolveObjectKeyFromUrl.mockImplementation(
      (value: string) => value === source ? objectKey : null,
    );
    storageMocks.getObjectStream.mockResolvedValue({
      stream: Readable.from([png]),
      statusCode: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
      },
    });
    const fetchMock = vi.fn(() => {
      throw new Error('owned storage URLs must not use fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const staged = await stageXaisPublicReference(source);
    try {
      expect(await readFile(staged.path)).toEqual(png);
      expect(storageMocks.getObjectStream).toHaveBeenCalledWith(objectKey);
      expect(dnsMocks.lookup).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await staged.cleanup();
    }
  });

  it('keeps normal third-party image URLs on the public SSRF-checked fetch path', async () => {
    const source = 'https://provider.example/reference-public.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    storageMocks.tryResolveObjectKeyFromUrl.mockReturnValue(null);
    dnsMocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(dnsMocks.lookup).toHaveBeenCalledWith(
      'provider.example',
      { all: true, verbatim: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storageMocks.getObjectStream).not.toHaveBeenCalled();
  });
});
