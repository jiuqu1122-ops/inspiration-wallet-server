import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import {
  buildNewApiImageGenerationBody,
  chooseProviderForCapability,
  collectProviderModelIds,
  confirmXaisReferenceAttachment,
  filterProviderImageModels,
  generateNewApiImages,
  imageCapabilityForModel,
  imageUnitCredits,
  isNewApiGeminiImageDecodeError,
  isNewApiParamOverrideCopyError,
  isPublicNewApiImageReference,
  isRetryableXaisPollError,
  materializeNewApiReferenceImage,
  newApiImageRequestParams,
  parseXaisTaskId,
  providerSupportsImageModel,
  resolveImageModel,
  resolveNewApiImageModel,
  resolveNewApiImageResponse,
  resolveXaisModel,
  resolveXaisWorkerRatio,
  runXaisWorkerTask,
  sizeFromRatio,
  stageXaisPublicReference,
  uniqueImages,
  xaisAttachmentRegistrationUrls,
} from '../src/modules/ai/image-service.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet image provider normalization', () => {
  it('extracts the image channel model IDs returned by /v1/models', () => {
    expect(collectProviderModelIds({
      data: [
        { id: 'gemini-3-pro-image' },
        { id: 'gemini-3.1-flash-image' },
        { id: 'gemini-3-pro-image' },
        { id: '' },
      ],
    })).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
  });

  it('prefers the dedicated IMAGE channel over an LLM channel with legacy broad capabilities', () => {
    const llm = { name: 'codex', capabilities: ['LLM', 'IMAGE', 'VIDEO'] as const };
    const image = { name: 'newapi-image', capabilities: ['IMAGE'] as const };
    expect(chooseProviderForCapability([llm, image], 'IMAGE')).toBe(image);
    expect(chooseProviderForCapability([llm], 'IMAGE')).toBeUndefined();
  });

  it('keeps channel selection independent from the client provider label', () => {
    const xais = { name: 'xais-image', capabilities: ['IMAGE'] as const };
    const newApi = { name: 'newapi-image', capabilities: ['IMAGE'] as const };
    expect(chooseProviderForCapability([newApi, xais], 'IMAGE')).toBe(newApi);
    expect(chooseProviderForCapability([xais, newApi], 'IMAGE')).toBe(xais);
  });

  it('separates Nano Banana and GPT Image provider capabilities', () => {
    const nano = { capabilities: ['IMAGE_NANO_BANANA'] as const };
    const gpt = { capabilities: ['IMAGE_GPT'] as const };
    const legacy = { capabilities: ['IMAGE'] as const };

    expect(imageCapabilityForModel('gemini-3-pro-image')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('Xais Nano Pro_2K')).toBe('IMAGE_NANO_BANANA');
    expect(imageCapabilityForModel('gpt-image-2')).toBe('IMAGE_GPT');
    expect(imageCapabilityForModel('Image2_4K')).toBe('IMAGE_GPT');
    expect(providerSupportsImageModel(nano, 'gpt-image-2')).toBe(false);
    expect(providerSupportsImageModel(gpt, 'gemini-3.1-flash-image')).toBe(false);
    expect(providerSupportsImageModel(legacy, 'custom-image-model')).toBe(true);
    expect(filterProviderImageModels(nano, [
      'gemini-3-pro-image',
      'gemini-2.5-pro',
      'gpt-image-2',
    ])).toEqual(['gemini-3-pro-image']);
  });

  it('uses the client-selected image model and keeps the manager model as fallback', () => {
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, 'gemini-3.1-flash-image'))
      .toBe('gemini-3.1-flash-image');
    expect(resolveImageModel({ kind: 'NEW_API', defaultModel: 'gemini-3-pro-image' }, ''))
      .toBe('gemini-3-pro-image');
    expect(() => resolveImageModel({ kind: 'NEW_API', defaultModel: null }, ''))
      .toThrow('生图请求和渠道都没有配置模型');
  });

  it('maps the main app image aliases back to NewAPI model IDs', () => {
    expect(resolveNewApiImageModel('Nano Banana Pro')).toBe('gemini-3-pro-image');
    expect(resolveNewApiImageModel('google/gemini_3_pro_image_preview')).toBe('gemini-3-pro-image');
    expect(resolveNewApiImageModel('Nano Banana 2')).toBe('gemini-3.1-flash-image');
    expect(resolveNewApiImageModel('Gemini31FlashImage')).toBe('gemini-3.1-flash-image');
    expect(resolveNewApiImageModel('GPT Image 2')).toBe('gpt-image-2');
    expect(resolveNewApiImageModel('「Hu」gpt-image-2')).toBe('「Hu」gpt-image-2');
    expect(resolveNewApiImageModel('「CS」gpt-image-2')).toBe('「CS」gpt-image-2');
    expect(resolveNewApiImageModel('「Rim」gemini-3-pro-image-preview')).toBe('「Rim」gemini-3-pro-image-preview');
    expect(resolveNewApiImageModel('custom-image-model')).toBe('custom-image-model');
  });

  it('extracts URL and Base64 image results while excluding reference inputs', () => {
    const reference = 'https://assets.example.test/reference.png';
    const images = uniqueImages({
      data: [
        { url: reference },
        { url: 'https://assets.example.test/output.png' },
        { b64_json: 'aGVsbG8=' },
      ],
    }, [reference], 4);

    expect(images).toEqual([
      'https://assets.example.test/output.png',
      'data:image/png;base64,aGVsbG8=',
    ]);
  });

  it('maps canvas XAIS display models to worker request models', () => {
    expect(resolveXaisModel('Xais Nano Pro_2K')).toBe('Nano_Banana_Pro_2K_0');
    expect(resolveXaisModel('Nano Banana Pro 4K')).toBe('Nano_Banana_Pro_4K_0');
    expect(resolveXaisModel('Xais Image2 2K High Quality')).toBe('Xais_Img2_2K_H');
    expect(resolveXaisModel('custom-model')).toBe('custom-model');
  });

  it('maps UI aspect ratios to the exact XAIS worker dimensions', () => {
    expect(resolveXaisWorkerRatio('Xais Img2_2K', '16:9')).toBe('2048x1152');
    expect(resolveXaisWorkerRatio('Xais Img2_4K', '9:16')).toBe('2160x3840');
    expect(resolveXaisWorkerRatio('Xais Nano Pro_2K', '16:9')).toBe('16:9');
  });

  it('keeps existing data URL references unchanged', async () => {
    const source = 'data:image/png;base64,aGVsbG8=';
    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(source);
  });

  it('keeps compatibility with image content types outside the legacy magic-byte list', async () => {
    const source = 'https://1.1.1.1/reference-compatible.svg';
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
    })));

    await expect(materializeNewApiReferenceImage(source)).resolves.toBe(
      `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    );
  });

  it('retries transient non-image Cloudflare responses and cleans the staged file', async () => {
    const source = 'https://1.1.1.1/reference-retry.png';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>cloudflare tunnel not ready</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(png, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const staged = await stageXaisPublicReference(source, async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(staged.mime).toBe('image/png');
    expect(staged.size).toBe(png.byteLength);
    expect(await readFile(staged.path)).toEqual(png);

    await staged.cleanup();
    await expect(access(staged.path)).rejects.toThrow();
  });

  it('rejects a repeatedly truncated public reference without retaining a temp file', async () => {
    const source = 'https://1.1.1.1/reference-truncated.png';
    const pngPrefix = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(pngPrefix, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(pngPrefix.byteLength + 1024),
      },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stageXaisPublicReference(source, async () => {}))
      .rejects.toThrow('content-length mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses stable OpenAI-compatible dimensions for supported ratios', () => {
    expect(sizeFromRatio('1:1')).toBe('1024x1024');
    expect(sizeFromRatio('16:9')).toBe('1792x1024');
    expect(sizeFromRatio('9:16')).toBe('1024x1792');
  });

  it('prices unified image families by clarity without depending on the provider', () => {
    expect(imageUnitCredits('gemini-3-pro-image', '2K')).toBe(18n);
    expect(imageUnitCredits('Xais Nano Pro_4K', '2K')).toBe(18n);
    expect(imageUnitCredits('gemini-3.1-flash-image', '2K')).toBe(15n);
    expect(imageUnitCredits('Xais Nano2_4K', '2K')).toBe(15n);
    expect(imageUnitCredits('gpt-image-2', '1K')).toBe(10n);
    expect(imageUnitCredits('Image2_2K', '4K')).toBe(18n);
    expect(imageUnitCredits('Xais Img2_4K', '2K')).toBe(15n);
    expect(imageUnitCredits('Xais Img2_2K(高画质)', '4K')).toBe(35n);
    expect(imageUnitCredits('Xais_Img2_4K_H', '2K')).toBe(30n);
  });

  it('extracts Gemini inline_data image results', () => {
    expect(uniqueImages({
      choices: [{
        message: {
          content: [{ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } }],
        },
      }],
    }, [], 1)).toEqual(['data:image/png;base64,aGVsbG8=']);
  });

  it('extracts raw image Base64 returned in result fields', () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    expect(uniqueImages({ output: [{ result: rawPng }] }, [], 1))
      .toEqual([`data:image/png;base64,${rawPng}`]);
  });

  it('accepts XAIS task IDs returned as plain text or nested results', () => {
    expect(parseXaisTaskId('task-plain-123')).toBe('task-plain-123');
    expect(parseXaisTaskId({ results: [{ taskid: 456789 }] })).toBe('456789');
  });

  it('keeps polling an XAIS task after transient transport failures', () => {
    expect(isRetryableXaisPollError(new Error('This operation was aborted'))).toBe(true);
    expect(isRetryableXaisPollError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isRetryableXaisPollError(new Error('provided image is not valid'))).toBe(false);
  });

  it('matches the upstream NewAPI image request parameters', () => {
    expect(newApiImageRequestParams('gemini-3-pro-image', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
    });
    expect(newApiImageRequestParams('gemini-3.1-flash-image', 2, '9:16', '4K')).toEqual({
      n: 2,
      size: '2160x3840',
      aspect_ratio: '9:16',
      output_resolution: '4K',
      image_size: '4K',
    });
    expect(newApiImageRequestParams('gpt-image-2', 1, '16:9', '1K')).toEqual({
      n: 1,
      size: '1280x720',
      aspect_ratio: '16:9',
      quality: 'medium',
    });
    expect(newApiImageRequestParams('gpt-image-2', 1, '16:9', '2K')).toEqual({
      n: 1,
      size: '2048x1152',
      aspect_ratio: '16:9',
      quality: 'medium',
    });
  });

  it('keeps NewAPI image references on the public URL path', () => {
    expect(isPublicNewApiImageReference('https://assets.example.test/reference.png')).toBe(true);
    expect(isPublicNewApiImageReference('data:image/png;base64,aGVsbG8=')).toBe(false);
    expect(isPublicNewApiImageReference('C:\\cache\\reference.png')).toBe(false);
  });

  it('only accepts XAIS attachment registrations that resolve an image URL', () => {
    expect(xaisAttachmentRegistrationUrls({ data: { url: 'https://xais.example.test/reference.png' } }))
      .toEqual(['https://xais.example.test/reference.png']);
    expect(xaisAttachmentRegistrationUrls({ success: true, data: {} })).toEqual([]);
  });

  it('retries XAIS attachment registration and rejects an unresolved attachment', async () => {
    const provider = { baseUrl: 'https://provider.example' } as Parameters<typeof confirmXaisReferenceAttachment>[0];
    const secrets = { apiKey: 'test-key', headers: {} };
    const noWait = async () => {};
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporary unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { url: 'https://xais.example.test/reference.png' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmXaisReferenceAttachment(provider, secrets, 'h2/reference.png', noWait))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(confirmXaisReferenceAttachment(provider, secrets, 'h2/missing.png', noWait))
      .rejects.toThrow('XAIS reference attachment registration failed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('starts an XAIS task with the confirmed attachment name in ref', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://1.1.1.1/upload',
        name: 'h2/reference.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/reference.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/output.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-1',
        model: 'Xais Nano Pro_2K',
        prompt: 'keep the reference product shape',
        inputImages: ['data:image/png;base64,aGVsbG8='],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/output.png');

    const taskStartCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/xais/workerTaskStart'));
    expect(taskStartCall).toBeDefined();
    expect(JSON.parse(String(taskStartCall?.[1]?.body))).toMatchObject({
      ref: ['h2/reference.png'],
    });
  });

  it('keeps legacy public image references working through the XAIS attachment flow', async () => {
    const reference = 'https://1.1.1.1/legacy-reference.svg';
    const referenceBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    let uploadedBytes = Buffer.alloc(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://1.1.1.1/upload',
        name: 'legacy/reference.jpg',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockImplementationOnce(async (_url, init) => {
        uploadedBytes = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response('', { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/reference.jpg',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: 'https://xais.example.test/output.png',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runXaisWorkerTask(
      { baseUrl: 'https://provider.example' } as Parameters<typeof runXaisWorkerTask>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-legacy',
        clientRequestId: 'request-legacy-public-reference',
        model: 'Xais Nano Pro_2K',
        prompt: 'keep the reference product shape',
        inputImages: [reference],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        count: 1,
      },
    )).resolves.toBe('https://xais.example.test/output.png');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(reference);
    expect(uploadedBytes).toEqual(referenceBytes);
  });

  it('recognizes a broken NewAPI channel parameter override', () => {
    expect(isNewApiParamOverrideCopyError(
      new Error('status_code=500, operation copy failed: source path does not exist: input.0.content.0.text'),
    )).toBe(true);
    expect(isNewApiParamOverrideCopyError(new Error('reference image HTTP 404'))).toBe(false);
    expect(isNewApiGeminiImageDecodeError(
      'gemini-3.1-flash-image',
      new Error('Bad request to gemini-flash: Failed to decode image data. Please make sure the image is valid.'),
    )).toBe(true);
    expect(isNewApiGeminiImageDecodeError(
      'gpt-image-2',
      new Error('Failed to decode image data'),
    )).toBe(false);
  });

  it('builds NewAPI image fields with reference and exact aspect-ratio size', () => {
    const reference = 'https://example.trycloudflare.com/reference.png';
    const body = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-1',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      inputImages: [reference],
      aspectRatio: '16:9',
      resolution: '2K',
      outputFormat: 'jpg',
      count: 1,
    }, [reference]);

    expect(body).toMatchObject({
      model: 'gemini-3-pro-image',
      prompt: expect.stringContaining('render the projector'),
      image: reference,
      size: '2048x1152',
      aspect_ratio: '16:9',
      output_resolution: '2K',
      image_size: '2K',
      response_format: 'url',
      stream: false,
    });
  });

  it('uploads inline references through the NewAPI multipart edits endpoint', async () => {
    const reference = 'data:image/png;base64,aGVsbG8=';
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    let multipartBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      multipartBody = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()).toString('utf8');
      return new Response(JSON.stringify({
        output: [{ result: outputPng }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-inline-reference',
        model: 'gemini-3-pro-image',
        prompt: 'redesign the handle',
        inputImages: [reference],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${outputPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(String(fetchMock.mock.calls[0]?.[1]?.headers.get('content-type')))
      .toContain('multipart/form-data; boundary=');
    expect(multipartBody).toContain('name="image"; filename="reference-1.png"');
    expect(multipartBody).toContain('name="aspect_ratio"\r\n\r\n16:9');
    expect(multipartBody).toContain('name="size"\r\n\r\n2048x1152');
  });

  it('streams legacy public references through disk to the NewAPI edits endpoint', async () => {
    const reference = 'https://1.1.1.1/legacy-reference.png';
    const referenceBytes = Buffer.from('legacy-reference-image-bytes');
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    let multipartBytes = Buffer.alloc(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(referenceBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(referenceBytes.byteLength),
        },
      }))
      .mockImplementationOnce(async (_url, init) => {
        multipartBytes = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response(JSON.stringify({
          output: [{ result: outputPng }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-legacy',
        clientRequestId: 'request-legacy-newapi-reference',
        model: 'gemini-3-pro-image',
        prompt: 'redesign the handle',
        inputImages: [reference],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${outputPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(reference);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://provider.example/v1/images/edits');
    expect(multipartBytes.includes(referenceBytes)).toBe(true);
  });

  it('enables async image tasks for 4K and multiple references', () => {
    const references = [
      'https://example.test/reference-1.png',
      'https://example.test/reference-2.png',
    ];
    const body = buildNewApiImageGenerationBody({
      userId: 'user-1',
      clientRequestId: 'request-1',
      model: 'gemini-3-pro-image',
      prompt: 'render the projector',
      inputImages: references,
      aspectRatio: '16:9',
      resolution: '4K',
      outputFormat: 'jpg',
      count: 1,
    }, references);
    expect(body).toMatchObject({
      images: references,
      size: '3840x2160',
      aspect_ratio: '16:9',
      async: true,
      stream: false,
    });
  });

  it('uses the NewAPI images/generations endpoint', async () => {
    const rawPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ result: rawPng }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateNewApiImages(
      { baseUrl: 'https://provider.example' } as Parameters<typeof generateNewApiImages>[0],
      { apiKey: 'test-key', headers: {} },
      {
        userId: 'user-1',
        clientRequestId: 'request-1',
        model: 'gemini-3-pro-image',
        prompt: 'render the projector',
        inputImages: [],
        aspectRatio: '16:9',
        resolution: '2K',
        outputFormat: 'jpg',
        count: 1,
      },
    )).resolves.toEqual([`data:image/png;base64,${rawPng}`]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/images/generations');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'gemini-3-pro-image',
      size: '2048x1152',
      aspect_ratio: '16:9',
      response_format: 'url',
      stream: false,
    });
  });

  it('polls an async NewAPI image task and downloads binary content when needed', async () => {
    const outputPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYQAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from(outputPng, 'base64'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const images = await resolveNewApiImageResponse(
      { baseUrl: 'https://provider.example' } as Parameters<typeof resolveNewApiImageResponse>[0],
      { apiKey: 'test-key', headers: {} },
      { task_id: 'task-123', status: 'queued' },
      [],
      1,
      async () => {},
    );

    expect(images).toEqual([`data:image/png;base64,${outputPng}`]);
    expect(fetchMock.mock.calls[0]?.[0])
      .toBe('https://provider.example/v1/images/generations/task-123');
    expect(fetchMock.mock.calls[1]?.[0])
      .toBe('https://provider.example/v1/images/task-123/content');
  });

});
