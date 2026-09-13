import { describe, expect, it, vi } from 'vitest';
import { encryptProviderSecrets } from '../src/lib/provider-secrets.js';
import {
  buildProviderProbeBody,
  testProvider,
} from '../src/modules/providers/service.js';

function provider(
  kind: 'MIKOTO' | 'BIGMODEL' | 'MINIMAX' | 'USELG',
  capabilities: string[],
  defaultModel = 'gpt-5.4',
) {
  return {
    id: 'provider-test-1',
    kind,
    name: kind,
    baseUrl: 'https://example.com',
    allowInsecureHttp: false,
    defaultModel,
    capabilities,
    encryptedSecrets: encryptProviderSecrets({ apiKey: 'test-api-key-123456', headers: {} }),
  } as never;
}

function prismaFor(value: unknown) {
  return {
    aiProviderChannel: {
      findUnique: vi.fn(async () => value),
      update: vi.fn(async ({ data }: { data: unknown }) => data),
    },
  } as never;
}

describe('provider connection probes', () => {
  it('checks Mikoto with a real OpenAI-compatible completion request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-5.4' }, { id: 'gpt-image-2' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('MIKOTO', ['LLM'])),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('LLM probe passed (gpt-5.4)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const probeInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const probeBody = JSON.parse(String(probeInit.body)) as Record<string, unknown>;
    expect(probeBody).toMatchObject({ model: 'gpt-5.4', stream: false, max_tokens: 1 });
    expect(new Headers(probeInit.headers).get('authorization')).toBe('Bearer test-api-key-123456');
  });

  it('checks MiniMax through its non-billing video query endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('task not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('MINIMAX', ['VIDEO_MINIMAX'], 'MiniMax-H3')),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe('连接成功；MiniMax H3 视频接口可访问');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://example.com/api/minimax/v2/query/video_generation?task_id=probe',
    );
  });

  it('checks the JSON and image contract for a Vision channel', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'qwen-vl-max' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"label":"square"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('MIKOTO', ['VISION'], 'qwen-vl-max')),
      'provider-test-1',
    );

    expect(result.message).toContain('Vision probe passed (qwen-vl-max)');
    const probeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(probeBody).toMatchObject({ response_format: { type: 'json_object' }, stream: false });
  });

  it('checks a standalone USELG Vision channel through OpenAI chat completions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-image-2' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"label":"square"}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('USELG', ['VISION', 'IMAGE_GPT'], 'gpt-5.6-luna')),
      'provider-test-1',
    );

    expect(result.message).toContain('Vision probe passed (gpt-5.6-luna)');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://example.com/v1/chat/completions',
    );
    const probeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(probeBody).toMatchObject({
      model: 'gpt-5.6-luna',
      response_format: { type: 'json_object' },
      stream: false,
    });
  });

  it('checks a standalone USELG LLM channel through OpenAI chat completions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-image-2' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('USELG', ['LLM', 'IMAGE_GPT'], 'gpt-5.6-luna')),
      'provider-test-1',
    );

    expect(result.message).toContain('LLM probe passed (gpt-5.6-luna)');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://example.com/v1/chat/completions',
    );
    const probeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(probeBody).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: false,
      max_tokens: 1,
    });
    expect(probeBody).not.toHaveProperty('response_format');
  });

  it('tests Bigmodel OpenAI text and native image catalogs independently', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/gemini-3-pro-image-preview' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('BIGMODEL', ['LLM', 'IMAGE_NANO_BANANA'])),
      'provider-test-1',
    );

    expect(result.modelCount).toBe(2);
    expect(result.message).toContain('LLM probe passed (gpt-5.4)');
    const imageInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(imageInit.headers).get('x-goog-api-key')).toBe('test-api-key-123456');
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('https://example.com/v1/chat/completions');
  });

  it('does not hide a broken Bigmodel image protocol behind a successful LLM catalog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('invalid image credential', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testProvider(
      prismaFor(provider('BIGMODEL', ['LLM', 'IMAGE_NANO_BANANA'])),
      'provider-test-1',
    )).rejects.toThrow('Bigmodel image protocol is unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps Bigmodel GPT Image on the OpenAI-compatible route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('BIGMODEL', ['IMAGE_GPT'], 'gpt-image-2')),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.com/v1/models');
  });

  it('recognizes fast Banana capabilities as native Bigmodel image channels', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'models/gemini-3-pro-image-preview' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('BIGMODEL', ['IMAGE_NANO_BANANA_PRO_FAST'], 'gemini-3-pro-image-preview')),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.com/v1beta/models');
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get('x-goog-api-key')).toBe('test-api-key-123456');
  });

  it('tests a generic Bigmodel channel through model discovery without a model-family enum', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'models/future-image-v9' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('BIGMODEL', ['IMAGE'], 'future-image-v9')),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.com/v1beta/models');
  });

  it('does not force a Chat probe when a channel only discovers image models', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'future-image-v9' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('USELG', ['IMAGE'], 'future-image-v9')),
      'provider-test-1',
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 models discovered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a configured Mikoto model when chat works but model listing is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('model list disabled', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider(
      prismaFor(provider('MIKOTO', ['LLM'], 'gpt-5.6-sol')),
      'provider-test-1',
    );

    expect(result.message).toContain('model catalog unavailable');
    expect(result.message).toContain('LLM probe passed (gpt-5.6-sol)');
  });

  it('builds a low-cost text and vision probe without exposing credentials', () => {
    expect(buildProviderProbeBody('gpt-5.4')).toMatchObject({
      model: 'gpt-5.4',
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    const vision = buildProviderProbeBody('gpt-4o', true);
    expect(vision).toMatchObject({
      stream: false,
      max_tokens: 32,
    });
    expect(vision.messages[0]?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('JSON'),
    });
    expect(vision.messages[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
    expect(JSON.stringify(vision)).not.toContain('api-key');
  });
});
