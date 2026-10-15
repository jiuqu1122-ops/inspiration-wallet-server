import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePreparedImageAdapterImages, prepareRouteImageAdapterRequest } from '../src/modules/ai/image-service.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('fresh receipts on the ai-media Midjourney gateway', () => {
  it.each([
    ['DIRECT', 'body'], ['TASK', 'body'], ['INHERIT', 'body'],
    ['DIRECT', 'header'], ['TASK', 'header'], ['INHERIT', 'header'],
  ] as const)('isolates new %s jobs when the gateway caches by %s and reuses the same logical receipt on retry', async (executionMode, cacheBy) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const provider = { id: 'channel', name: 'Fixture', kind: 'NEW_API', baseUrl: 'https://api.ai-media.vip', capabilities: ['IMAGE'] };
    const capabilities = { outputMode: 'multiple_assets', maxOutputImages: 4, billingMode: 'per_request' };
    const route = { requestedCanonicalModel: 'midjourney-v7', resolvedCanonicalModel: 'midjourney-v7',
      canonicalModelId: 'model', canonicalModelKey: 'midjourney-v7', routeId: 'route', channelId: provider.id,
      upstreamModel: 'Midjourney V7（满血）', adapterKey: 'GENERIC_OPENAI_IMAGE',
      adapterConfig: { generationEndpoint: '/v1/images/generations?token=private-endpoint-token' }, executionMode,
      executionConfig: { profile: 'GENERIC_TASK', submitEndpoint: '/v1/images/generations?token=private-endpoint-token', statusEndpointTemplate: '/v1/images/tasks/{taskId}' } };
    const input = { userId: 'owner', clientRequestId: 'fresh-request-a', model: route.upstreamModel,
      prompt: 'private fixture prompt', inputImages: [], aspectRatio: '1:1', resolution: '2k',
      outputFormat: 'png' as const, count: 1, imageCapabilities: capabilities };
    const prepared = await prepareRouteImageAdapterRequest(provider as never, input, route as never);
    const oldBody = JSON.stringify({ ...prepared!.body,
      prompt: String(prepared!.body.prompt).replace(/\s+--seed \d+$/, '') });
    const priorImages = Array.from({ length: 4 }, (_, index) => ({ url: `https://cdn.example/old-${index}.png` }));
    const receipts = new Map<string, { task_id: string; status: string; data: { url: string }[] }>([
      [cacheBy === 'body' ? oldBody : 'channel-wide-fixed-receipt', { task_id: 'old-task', status: 'success', data: priorImages }],
    ]);
    const created: string[] = [];
    const submissions: { headers: Headers; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      submissions.push({ headers, body });
      const key = cacheBy === 'body' ? body : headers.get('idempotency-key') || body;
      let response = receipts.get(key);
      if (!response) {
        const task_id = `new-task-${created.length}`;
        created.push(task_id);
        response = { task_id, status: 'success', data: priorImages.map((_image, index) => ({ url: `https://cdn.example/${task_id}-${index}.png` })) };
        receipts.set(key, response);
      }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    }));
    const run = async (clientRequestId: string) => {
      const request = { ...input, clientRequestId };
      const prepared = await prepareRouteImageAdapterRequest(provider as never, request, route as never);
      return generatePreparedImageAdapterImages(provider as never, {
        apiKey: 'fixture-secret', headers: { 'Idempotency-Key': 'channel-wide-fixed-receipt', 'X-Request-Id': 'channel-wide-fixed-receipt' },
      }, request, prepared!, route as never, { wait: async () => {} });
    };
    const first = await run('fresh-request-a');
    const second = await run('fresh-request-b');
    const retried = await run('fresh-request-a');
    expect(first).toEqual(priorImages.map((_image, index) => `https://cdn.example/new-task-0-${index}.png`));
    expect(second).toEqual(priorImages.map((_image, index) => `https://cdn.example/new-task-1-${index}.png`));
    expect(retried).toEqual(first);
    expect(created).toHaveLength(2);
    expect(submissions).toHaveLength(3); // One explicit POST per invocation; no automatic resubmission.
    expect(new Set(submissions.map(submission => submission.body)).size).toBe(2);
    const keys = submissions.map(submission => submission.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(submissions.map(submission => submission.headers.get('x-request-id'))).toEqual(keys);
    expect(submissions.map(submission => submission.headers.get('cache-control'))).toEqual(Array(3).fill('no-cache, no-store'));
    expect(submissions.map(submission => submission.headers.get('pragma'))).toEqual(Array(3).fill('no-cache'));
    const bodies = submissions.map(submission => JSON.parse(submission.body) as Record<string, unknown>);
    const prompts = bodies.map(body => String(body.prompt));
    expect(prompts[0]).toMatch(/Strict image constraints:[\s\S]*\.\s+--seed \d+$/);
    expect(prompts.map(prompt => prompt.replace(/\s+--seed \d+$/, ''))).toEqual(Array(3).fill(JSON.parse(oldBody).prompt));
    expect(bodies.map(body => ({ ...body, prompt: '' }))).toEqual(Array.from({ length: 3 }, () => ({ ...prepared!.body, prompt: '' })));
    const events = vi.mocked(console.info).mock.calls;
    const attempts = events.filter(event => event[0] === '[image_adapter_submit_started]').map(event => event[1]);
    expect(attempts).toHaveLength(3);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientRequestId: 'fresh-request-a', providerKind: 'NEW_API', method: 'POST',
        requestBodyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), hasConfiguredIdempotencyHeader: true, hasConfiguredRequestIdHeader: true }),
      expect.objectContaining({ clientRequestId: 'fresh-request-b' }),
    ]));
    expect(new Set(attempts.map(event => event.requestBodyFingerprint)).size).toBe(2);
    expect(events.filter(event => event[0] === '[image_adapter_submit_completed]').map(event => event[1].taskId)).toEqual(['new-task-0', 'new-task-1', 'new-task-0']);
    for (const privateValue of [input.prompt, 'fixture-secret', 'channel-wide-fixed-receipt', 'https://cdn.example/old-0.png', 'private-endpoint-token']) {
      expect(JSON.stringify(events)).not.toContain(privateValue);
    }
  });
});
