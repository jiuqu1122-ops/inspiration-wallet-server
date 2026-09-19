import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectImageStrings,
  generatePreparedImageAdapterImages,
  normalizeUselgImageStatusUrl,
  parseProviderResponse,
  providerRequest,
  resolveUselgImageResponse,
  summarizeUselgImageStatus,
} from '../src/modules/ai/image-service.js';
import {
  runImageResponseDiagnosticRequest,
  startImageResponseDiagnostic,
} from '../src/modules/ai/image-response-diagnostics.js';

const openServers: Server[] = [];

async function localServer(
  handler: (requestUrl: string, method: string, response: ServerResponse) => void,
) {
  const server = createServer((request, response) => {
    handler(request.url ?? '/', request.method ?? 'GET', response);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openServers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function diagnosticScope(targetUrl: string, clientRequestId = 'diagnostic-request') {
  return startImageResponseDiagnostic({
    clientRequestId,
    providerId: 'diagnostic-provider',
    routeId: 'diagnostic-route',
    adapterKey: 'LEGACY',
    phase: 'status',
    attempt: 1,
    addressSource: 'upstream',
    targetUrl,
    timeoutMs: 250,
    method: 'GET',
    detailedOverride: true,
  });
}

describe('USELG image response diagnostics', () => {
  it('adds summary only to the exact same-origin USELG task status URL', () => {
    const provider = { baseUrl: 'https://provider.example' } as never;

    expect(normalizeUselgImageStatusUrl(
      provider,
      '/v1/images/tasks/task-123',
      'task-123',
    )).toBe('/v1/images/tasks/task-123?view=summary');
    expect(normalizeUselgImageStatusUrl(
      provider,
      '/v1/images/tasks/task-123?view=summary',
      'task-123',
    )).toBe('/v1/images/tasks/task-123?view=summary');
    expect(normalizeUselgImageStatusUrl(
      provider,
      '/v1/images/tasks/task-123?trace=enabled',
      'task-123',
    )).toBe('/v1/images/tasks/task-123?trace=enabled&view=summary');
    expect(normalizeUselgImageStatusUrl(
      provider,
      '/v1/custom-tasks/task-123',
      'task-123',
    )).toBe('/v1/custom-tasks/task-123');
    expect(normalizeUselgImageStatusUrl(
      provider,
      'https://other.example/v1/images/tasks/task-123',
      'task-123',
    )).toBe('https://other.example/v1/images/tasks/task-123');
  });

  it('parses small URL JSON, BOM JSON, SSE events, and non-JSON text compatibly', () => {
    expect(parseProviderResponse('{"data":[{"url":"https://cdn.example/image.png"}]}')).toEqual({
      value: { data: [{ url: 'https://cdn.example/image.png' }] },
      parseType: 'json',
    });
    expect(summarizeUselgImageStatus(
      { data: [{ url: 'https://cdn.example/image.png' }] },
      [],
      1,
    ).images).toEqual(['https://cdn.example/image.png']);
    expect(parseProviderResponse('\uFEFF  {"status":"success"}')).toEqual({
      value: { status: 'success' },
      parseType: 'json',
    });
    expect(parseProviderResponse('data: {"status":"queued"}\n\ndata: {"status":"success"}\n\ndata: [DONE]\n')).toEqual({
      value: [{ status: 'queued' }, { status: 'success' }],
      parseType: 'sse',
    });
    expect(parseProviderResponse('upstream temporarily unavailable')).toEqual({
      value: 'upstream temporarily unavailable',
      parseType: 'text',
    });
  });

  it('extracts multi-megabyte inlineData and b64_json once without recursion failures', () => {
    const inlineData = `iVBORw0KGgo${'A'.repeat(2 * 1024 * 1024)}`;
    const b64Json = `iVBORw0KGgo${'B'.repeat(3 * 1024 * 1024)}`;
    const response: Record<string, unknown> = {
      data: [
        { inlineData: { mimeType: 'image/png', data: inlineData } },
        { b64_json: b64Json },
      ],
    };
    response.cycle = response;

    const images = collectImageStrings(response);
    const summary = summarizeUselgImageStatus({ status: 'success', result: response }, [], 2);

    expect(images).toHaveLength(2);
    expect(summary.images).toHaveLength(2);
    expect(summary.images[0]).toHaveLength('data:image/png;base64,'.length + inlineData.length);
    expect(summary.images[1]).toHaveLength('data:image/png;base64,'.length + b64Json.length);
  });

  it('accepts a valid inline image when status and assets are absent', () => {
    const inline = `iVBORw0KGgo${'C'.repeat(1024)}`;
    expect(summarizeUselgImageStatus({
      response: { inlineData: { mimeType: 'image/png', data: inline } },
    }, [], 1)).toMatchObject({
      state: '',
      assets: [],
      images: [`data:image/png;base64,${inline}`],
    });
  });

  it('separates delayed response headers from body/parse timing', async () => {
    const baseUrl = await localServer((_url, _method, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"success"}');
      }, 60);
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const scope = diagnosticScope(`${baseUrl}/status?token=do-not-log`);

    await expect(runImageResponseDiagnosticRequest(
      scope,
      current => providerRequest(
        { id: 'diagnostic-provider', baseUrl, kind: 'USELG' } as never,
        { apiKey: 'secret-api-key', headers: {} },
        '/status?token=do-not-log',
        undefined,
        250,
        undefined,
        undefined,
        current,
      ),
    )).resolves.toMatchObject({ value: { status: 'success' } });

    const events = info.mock.calls
      .filter(([prefix]) => prefix === '[image_response_diagnostic]')
      .map(([, event]) => event as Record<string, unknown>);
    expect(events.map(event => event.event)).toEqual([
      'request_started',
      'response_headers',
      'response_body_complete',
      'response_parse_complete',
    ]);
    expect(events[1]?.headersWaitMs).toEqual(expect.any(Number));
    expect(events[1]?.headersWaitMs as number).toBeGreaterThanOrEqual(40);
    expect(events[2]).toMatchObject({ decodedBodyBytes: 20, wireBodyBytes: null });
    expect(events[3]).toMatchObject({ parseType: 'json', topLevelType: 'object' });
  });

  it('identifies a timeout while reading a body that never ends', async () => {
    let reportResponseClosed = () => {};
    const responseClosed = new Promise<void>((resolve) => {
      reportResponseClosed = resolve;
    });
    const baseUrl = await localServer((_url, _method, response) => {
      response.once('close', reportResponseClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"status":"processing"');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scope = startImageResponseDiagnostic({
      clientRequestId: 'body-timeout-request',
      taskId: 'body-timeout-task',
      providerId: 'diagnostic-provider',
      phase: 'status',
      attempt: 1,
      addressSource: 'default',
      targetUrl: `${baseUrl}/status`,
      timeoutMs: 60,
      method: 'GET',
    });

    await expect(runImageResponseDiagnosticRequest(
      scope,
      current => providerRequest(
        { id: 'diagnostic-provider', baseUrl, kind: 'USELG' } as never,
        { apiKey: 'secret-api-key', headers: {} },
        '/status',
        undefined,
        60,
        undefined,
        undefined,
        current,
      ),
    )).rejects.toThrow();

    await expect(new Promise<void>((resolve, reject) => {
      const closeDeadline = setTimeout(
        () => reject(new Error('timed-out response body was not cancelled')),
        500,
      );
      void responseClosed.then(() => {
        clearTimeout(closeDeadline);
        resolve();
      }, reject);
    })).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith('[image_response_diagnostic]', expect.objectContaining({
      event: 'request_timeout',
      clientRequestId: 'body-timeout-request',
      taskId: 'body-timeout-task',
      failedStage: 'reading_body',
      timeoutTriggered: true,
    }));
  });

  it('retries a timed-out summary poll on the same submitted task without another POST', async () => {
    let getCount = 0;
    let postCount = 0;
    const polledUrls: string[] = [];
    const statusTimeouts: Array<number | undefined> = [];
    const baseUrl = await localServer((requestUrl, method, response) => {
      expect(method).toBe('GET');
      getCount += 1;
      polledUrls.push(requestUrl);
      if (getCount === 1) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"status":"processing"');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        task_id: 'same-task',
        status: 'success',
        assets: [{ signed_url: 'https://cdn.example.test/same-task.png' }],
      }));
    });
    const provider = { id: 'diagnostic-provider', baseUrl, kind: 'USELG' } as never;
    const secrets = { apiKey: 'secret-api-key', headers: {} };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(generatePreparedImageAdapterImages(
      provider,
      secrets,
      {
        userId: 'same-task-user',
        clientRequestId: 'same-task-request',
        model: 'gemini-image',
        prompt: 'same task retry',
        inputImages: [],
        aspectRatio: '1:1',
        outputFormat: 'png',
        count: 1,
      },
      {
        adapterKey: 'GENERIC_OPENAI_IMAGE',
        execution: 'images-api',
        submittedModel: 'gemini-image',
        endpoint: '/v1/images/generations',
        method: 'POST',
        contentType: 'application/json',
        body: {
          model: 'gemini-image',
          prompt: 'same task retry',
          async: true,
        },
      },
      {
        adapterKey: 'GENERIC_OPENAI_IMAGE',
        adapterConfig: { async: true },
        executionMode: 'TASK',
        executionConfig: {
          profile: 'USELG_IMAGE_TASK',
          submitEndpoint: '/v1/images/generations',
        },
        requestedCanonicalModel: 'gemini-image',
        resolvedCanonicalModel: 'gemini-image',
        canonicalModelId: 'same-task-model',
        canonicalModelKey: 'gemini-image',
        routeId: 'same-task-route',
        channelId: 'diagnostic-provider',
        upstreamModel: 'gemini-image',
      },
      {
        wait: async () => undefined,
        request: async (path, body, timeoutMs, _headers, onResponseStatus, scope) => {
          if (body !== undefined) {
            postCount += 1;
            return {
              task_id: 'same-task',
              status: 'queued',
              status_url: '/v1/images/tasks/same-task',
              poll_after_ms: 1,
            };
          }
          statusTimeouts.push(timeoutMs);
          return providerRequest(
            provider,
            secrets,
            path,
            undefined,
            50,
            undefined,
            onResponseStatus,
            scope,
          );
        },
      },
    )).resolves.toEqual(['https://cdn.example.test/same-task.png']);

    expect(getCount).toBe(2);
    expect(postCount).toBe(1);
    expect(statusTimeouts).toEqual([10_000, 10_000]);
    expect(polledUrls).toEqual([
      '/v1/images/tasks/same-task?view=summary',
      '/v1/images/tasks/same-task?view=summary',
    ]);
    expect(info).toHaveBeenCalledWith(
      '[image_response_diagnostic]',
      expect.objectContaining({
        event: 'request_started',
        phase: 'status',
        taskId: 'same-task',
        timeoutMs: 10_000,
      }),
    );
  });

  it('uses a completed summary result_url without reverting to the full status URL', async () => {
    const requestedPaths: string[] = [];
    const requestedTimeouts: Array<number | undefined> = [];
    let statusPoll = 0;

    await expect(resolveUselgImageResponse(
      { id: 'diagnostic-provider', baseUrl: 'https://provider.example', kind: 'USELG' } as never,
      { apiKey: 'secret-api-key', headers: {} },
      {
        task_id: 'result-task',
        status: 'queued',
        status_url: '/v1/images/tasks/result-task?trace=enabled',
        poll_after_ms: 1,
      },
      [],
      1,
      async () => undefined,
      undefined,
      async (path, _body, timeoutMs) => {
        requestedPaths.push(path);
        requestedTimeouts.push(timeoutMs);
        if (path.startsWith('/v1/images/tasks/result-task/result')) {
          return { data: [{ url: 'https://cdn.example.test/result-task.png' }] };
        }
        statusPoll += 1;
        if (statusPoll === 1) {
          return {
            task_id: 'result-task',
            status: 'processing',
            status_url: '/v1/images/tasks/result-task',
            poll_after_ms: 1,
          };
        }
        return {
          task_id: 'result-task',
          status: 'completed',
          result_url: '/v1/images/tasks/result-task/result?download=1',
        };
      },
    )).resolves.toEqual(['https://cdn.example.test/result-task.png']);

    expect(requestedPaths).toEqual([
      '/v1/images/tasks/result-task?trace=enabled&view=summary',
      '/v1/images/tasks/result-task?view=summary',
      '/v1/images/tasks/result-task/result?download=1',
    ]);
    expect(requestedTimeouts).toEqual([10_000, 10_000, 45_000]);
  });

  it('retries a timed-out USELG result body by polling the same task again', async () => {
    let resultAttempt = 0;
    const baseUrl = await localServer((_requestUrl, method, response) => {
      expect(method).toBe('GET');
      resultAttempt += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      if (resultAttempt === 1) {
        response.write('{"status":"processing"');
        return;
      }
      response.end(JSON.stringify({
        data: [{ url: 'https://cdn.example.test/result-after-timeout.png' }],
      }));
    });
    const provider = { id: 'diagnostic-provider', baseUrl, kind: 'USELG' } as never;
    const secrets = { apiKey: 'secret-api-key', headers: {} };
    const requestedPaths: string[] = [];

    await expect(resolveUselgImageResponse(
      provider,
      secrets,
      {
        task_id: 'result-timeout-task',
        status: 'queued',
        status_url: '/v1/images/tasks/result-timeout-task',
        poll_after_ms: 1,
      },
      [],
      1,
      async () => undefined,
      undefined,
      async (path, body, _timeout, onResponseStatus, scope) => {
        requestedPaths.push(path);
        if (!path.endsWith('/result')) {
          return {
            task_id: 'result-timeout-task',
            status: 'completed',
            result_url: '/v1/images/tasks/result-timeout-task/result',
          };
        }
        return providerRequest(
          provider,
          secrets,
          path,
          body,
          50,
          undefined,
          onResponseStatus,
          scope,
        );
      },
    )).resolves.toEqual(['https://cdn.example.test/result-after-timeout.png']);

    expect(resultAttempt).toBe(2);
    expect(requestedPaths).toEqual([
      '/v1/images/tasks/result-timeout-task?view=summary',
      '/v1/images/tasks/result-timeout-task/result',
      '/v1/images/tasks/result-timeout-task?view=summary',
      '/v1/images/tasks/result-timeout-task/result',
    ]);
  });

  it('keeps concurrent call IDs isolated by client request and task', async () => {
    const observed: Array<{
      callId: string;
      clientRequestId: string;
      taskId?: string;
      path: string;
    }> = [];
    const provider = {
      id: 'diagnostic-provider',
      baseUrl: 'https://provider.example',
      kind: 'USELG',
    } as never;
    const run = (suffix: string) => resolveUselgImageResponse(
      provider,
      { apiKey: 'secret-api-key', headers: {} },
      {
        task_id: `task-${suffix}`,
        status: 'queued',
        status_url: `/status/task-${suffix}`,
        poll_after_ms: 1,
      },
      [],
      1,
      async () => undefined,
      {
        clientRequestId: `client-${suffix}`,
        providerId: 'diagnostic-provider',
        model: 'gemini-image',
      },
      async (path, _body, _timeout, _onStatus, scope) => {
        expect(scope).toBeDefined();
        observed.push({
          callId: scope!.callId,
          clientRequestId: scope!.identity.clientRequestId,
          taskId: scope!.identity.taskId,
          path,
        });
        await Promise.resolve();
        return {
          task_id: `task-${suffix}`,
          status: 'success',
          assets: [{ signed_url: `https://cdn.example.test/${suffix}.png` }],
        };
      },
    );

    await expect(Promise.all([run('one'), run('two')])).resolves.toEqual([
      ['https://cdn.example.test/one.png'],
      ['https://cdn.example.test/two.png'],
    ]);
    expect(new Set(observed.map(entry => entry.callId))).toHaveLength(2);
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientRequestId: 'client-one', taskId: 'task-one', path: '/status/task-one' }),
      expect.objectContaining({ clientRequestId: 'client-two', taskId: 'task-two', path: '/status/task-two' }),
    ]));
  });

  it('redacts query values and never logs credentials, prompts, bodies, or image bytes', async () => {
    const baseUrl = await localServer((_url, _method, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[{"url":"https://cdn.example.test/final.png"}]}');
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const targetUrl = `${baseUrl}/status/task?token=secret-token&X-Amz-Signature=secret-signature`;
    const scope = diagnosticScope(targetUrl, 'redaction-request');

    await runImageResponseDiagnosticRequest(
      scope,
      current => providerRequest(
        { id: 'diagnostic-provider', baseUrl, kind: 'USELG' } as never,
        { apiKey: 'secret-api-key', headers: { 'x-secret': 'secret-header' } },
        '/status/task?token=secret-token&X-Amz-Signature=secret-signature',
        undefined,
        250,
        undefined,
        undefined,
        current,
      ),
    );

    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).toContain('token=<redacted>');
    expect(serialized).toContain('X-Amz-Signature=<redacted>');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret-signature');
    expect(serialized).not.toContain('secret-api-key');
    expect(serialized).not.toContain('secret-header');
    expect(serialized).not.toContain('https://cdn.example.test/final.png');
  });
});
