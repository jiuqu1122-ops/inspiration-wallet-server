import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectImageStrings,
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
    const baseUrl = await localServer((_url, _method, response) => {
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

    expect(warning).toHaveBeenCalledWith('[image_response_diagnostic]', expect.objectContaining({
      event: 'request_timeout',
      clientRequestId: 'body-timeout-request',
      taskId: 'body-timeout-task',
      failedStage: 'reading_body',
      timeoutTriggered: true,
    }));
  });

  it('retries a transient status timeout on the same task without a second generation POST', async () => {
    let getCount = 0;
    let postCount = 0;
    const baseUrl = await localServer((_url, method, response) => {
      if (method === 'POST') {
        postCount += 1;
        response.writeHead(500).end();
        return;
      }
      getCount += 1;
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

    await expect(resolveUselgImageResponse(
      provider,
      secrets,
      {
        task_id: 'same-task',
        status: 'queued',
        status_url: '/status/same-task',
        poll_after_ms: 1,
      },
      [],
      1,
      async () => undefined,
      {
        clientRequestId: 'same-task-request',
        providerId: 'diagnostic-provider',
        model: 'gemini-image',
      },
      (path, body, _timeout, onResponseStatus, scope) => providerRequest(
        provider,
        secrets,
        path,
        body,
        50,
        undefined,
        onResponseStatus,
        scope,
      ),
    )).resolves.toEqual(['https://cdn.example.test/same-task.png']);

    expect(getCount).toBe(2);
    expect(postCount).toBe(0);
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
