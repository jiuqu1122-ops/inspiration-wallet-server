import { describe, expect, it, vi } from 'vitest';
import {
  drainAgentCompletionStreamAfterDone,
  AgentUpstreamTimeoutError,
  buildAgentModelCandidates,
  buildSingleProviderAgentRetryModels,
  AgentCompletionResponseAccumulator,
  AgentCompletionSseParser,
  isAgentAmbiguousUpstreamStatus,
  isAgentProtocolFallbackStatus,
  isAgentProviderFallbackStatus,
  isAgentProviderRetryStatus,
  canFallbackToNextAgentProvider,
  canRetrySingleAgentProvider,
  canTryAlternativeAgentModel,
  isDefaultAgentModelSentinel,
  isLikelyAgentTextModel,
  shouldFallbackCanvasTextAgentToAutomaticModel,
  listInspirationProviders,
  looksLikeAgentSsePayload,
  getAgentRequestCredits,
  parseAgentCompletionResponseText,
  parseImageAnalysisResponsePayloads,
  providerSupportsInspirationAnalysis,
  resolveConfiguredAgentModel,
  sanitizeAgentUpstreamDetail,
} from '../src/modules/ai/service.js';
import { ModelCatalogError } from '../src/modules/ai/model-catalog.js';

describe('Agent provider fallback policy', () => {
  it('falls stale canvas text selections back to the configured automatic route only', () => {
    for (const code of ['MODEL_NOT_FOUND', 'MODEL_NOT_AVAILABLE', 'MODEL_ROUTE_NOT_AVAILABLE'] as const) {
      expect(shouldFallbackCanvasTextAgentToAutomaticModel(
        'canvas_text_agent',
        false,
        new ModelCatalogError(code, 'unavailable', 503),
      )).toBe(true);
    }
    expect(shouldFallbackCanvasTextAgentToAutomaticModel(
      'chat',
      false,
      new ModelCatalogError('MODEL_ROUTE_NOT_AVAILABLE', 'unavailable', 503),
    )).toBe(false);
    expect(shouldFallbackCanvasTextAgentToAutomaticModel(
      'canvas_text_agent',
      true,
      new ModelCatalogError('MODEL_ROUTE_NOT_AVAILABLE', 'unavailable', 503),
    )).toBe(false);
  });

  it('keeps USELG LLM and Vision capabilities independent', () => {
    expect(providerSupportsInspirationAnalysis({
      capabilities: ['VISION'],
    })).toBe(true);
    expect(providerSupportsInspirationAnalysis({
      capabilities: ['LLM', 'VISION'],
    })).toBe(true);
    expect(providerSupportsInspirationAnalysis({
      capabilities: ['LLM'],
    })).toBe(false);
  });

  it('never falls back from Vision requests to an Agent-only channel', async () => {
    const findMany = vi.fn(async () => []);
    await expect(listInspirationProviders({ aiProviderChannel: { findMany } } as never)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'ACTIVE', capabilities: { has: 'VISION' } },
    }));
  });

  it('charges ten server-side credits for each Agent request', () => {
    expect(getAgentRequestCredits()).toBe(10n);
  });

  it('uses the configured channel model for default model sentinels', () => {
    expect(isDefaultAgentModelSentinel(undefined)).toBe(true);
    expect(isDefaultAgentModelSentinel('unmind-agent')).toBe(true);
    expect(isDefaultAgentModelSentinel('recommended')).toBe(true);
    expect(isDefaultAgentModelSentinel('gpt-5.6-sol')).toBe(false);
  });

  it('keeps an explicitly selected model on every provider channel', () => {
    const primary = { defaultModel: 'primary-default' };
    const fallback = { defaultModel: 'fallback-default' };

    expect(resolveConfiguredAgentModel(primary, 'selected-model')).toBe('selected-model');
    expect(resolveConfiguredAgentModel(fallback, 'selected-model', true)).toBe('selected-model');
    expect(resolveConfiguredAgentModel({ defaultModel: null }, 'selected-model', true)).toBe('selected-model');
  });

  it('falls back for gateway failures and protocol-specific channel errors', () => {
    expect(isAgentProviderFallbackStatus(524)).toBe(false);
    expect(isAgentProviderFallbackStatus(504)).toBe(false);
    expect(isAgentProviderFallbackStatus(502)).toBe(true);
    expect(isAgentProviderFallbackStatus(429)).toBe(true);
    expect(isAgentProtocolFallbackStatus(404)).toBe(true);
    expect(isAgentProviderFallbackStatus(409)).toBe(false);
  });

  it('retries transient gateway errors without retrying protocol failures', () => {
    expect(isAgentProviderRetryStatus(504)).toBe(false);
    expect(isAgentProviderRetryStatus(524)).toBe(false);
    expect(isAgentProviderRetryStatus(503)).toBe(true);
    expect(isAgentProviderRetryStatus(429)).toBe(false);
    expect(isAgentProviderRetryStatus(400)).toBe(false);
    expect(isAgentProviderRetryStatus(401)).toBe(false);
  });

  it('treats HTTP 504 and 524 as ambiguous accepted-request timeouts', () => {
    expect(isAgentAmbiguousUpstreamStatus(504)).toBe(true);
    expect(isAgentAmbiguousUpstreamStatus(524)).toBe(true);
    expect(isAgentAmbiguousUpstreamStatus(503)).toBe(false);
  });

  it('never retries or fails over after an ambiguous upstream timeout', () => {
    for (const phase of ['first_response', 'stream_idle'] as const) {
      const error = new AgentUpstreamTimeoutError(phase, 300_000);
      expect(canRetrySingleAgentProvider(error)).toBe(false);
      expect(canTryAlternativeAgentModel(error)).toBe(false);
      expect(canFallbackToNextAgentProvider(error)).toBe(false);
    }
  });

  it('does not switch models after the user explicitly selected one', () => {
    expect(buildAgentModelCandidates(
      { defaultModel: 'claude-sonnet-4-5' },
      'gemini-2.5-pro',
      [
        'gemini-3-pro-image-preview',
        'text-embedding-3-large',
        'gemini-2.5-flash',
        'claude-sonnet-4-5',
      ],
    )).toEqual(['gemini-2.5-pro']);
  });

  it('sorts discovered automatic models by numeric version and preserves equal-version order', () => {
    expect(buildAgentModelCandidates(
      { defaultModel: null },
      'auto',
      [
        'gpt-5.5',
        'gpt-image-2',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.4',
      ],
    )).toEqual([
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('uses the configured channel default for automatic requests without leaking to discovered GPT models', () => {
    expect(buildAgentModelCandidates(
      { defaultModel: 'grok-4.6' },
      'default',
      ['gpt-6-astra', 'gpt-5.6-terra', 'grok-4.6'],
    )).toEqual(['grok-4.6']);
  });

  it('retries only the configured model instead of unrelated models exposed by the same channel', () => {
    expect(buildSingleProviderAgentRetryModels(
      { defaultModel: 'gpt-5.6-sol' },
      'unmind-agent',
      ['gpt-5.6-sol', 'gpt-5.4', 'gemini-2.5-pro', 'gpt-image-2'],
      'gpt-5.6-sol',
      true,
    )).toEqual(['gpt-5.6-sol']);
  });

  it('filters non-Agent models discovered on a mixed-capability channel', () => {
    expect(isLikelyAgentTextModel('gpt-5.4')).toBe(true);
    expect(isLikelyAgentTextModel('qwen3-vl-plus')).toBe(true);
    expect(isLikelyAgentTextModel('gpt-image-2')).toBe(false);
    expect(isLikelyAgentTextModel('Xais Nano Pro_2K')).toBe(false);
    expect(isLikelyAgentTextModel('seedance-1.5-pro')).toBe(false);
    expect(isLikelyAgentTextModel('text-embedding-3-large')).toBe(false);
  });

  it('redacts credentials from upstream error details', () => {
    const detail = sanitizeAgentUpstreamDetail(
      'authorization=sk-secretvalue123456 token=eyJabc.def.ghi request timed out',
    );
    expect(detail).not.toContain('secretvalue');
    expect(detail).not.toContain('eyJabc');
    expect(detail).toContain('[REDACTED]');
  });

  it('aggregates streamed text into a regular chat completion', () => {
    const result = parseAgentCompletionResponseText([
      'data: {"id":"chat-1","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hello "},"finish_reason":null}]}',
      '',
      'data: {"id":"chat-1","model":"gpt-test","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
    ].join('\n')) as Record<string, unknown>;

    expect(result).toMatchObject({
      id: 'chat-1',
      model: 'gpt-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello world' },
        finish_reason: 'stop',
      }],
    });
  });

  it('aggregates streamed tool call fragments', () => {
    const result = parseAgentCompletionResponseText([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"create_","arguments":"{\\"name\\":"}}]},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"node","arguments":"\\"concept\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
    ].join('\n')) as { choices: Array<Record<string, unknown>> };

    expect(result.choices[0]).toMatchObject({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'create_node', arguments: '{"name":"concept"}' },
        }],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('parses SSE events split across arbitrary network chunks', () => {
    const parser = new AgentCompletionSseParser();
    parser.push('data: {"choices":[{"index":0,"delta":{"content":"hel');
    parser.push('lo "},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,');
    parser.push('"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n');
    parser.push('data: [DONE]\n\n');
    expect(parser.finish()).toMatchObject({
      choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
    });
  });

  it('parses multiple SSE events delivered in one network chunk', () => {
    const parser = new AgentCompletionSseParser();
    parser.push([
      'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'));
    expect(parser.finish()).toMatchObject({
      choices: [{ message: { content: 'ab' }, finish_reason: 'stop' }],
    });
  });

  it('marks a stream complete as soon as DONE arrives without a trailing separator', () => {
    const parser = new AgentCompletionSseParser();
    parser.push('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
    expect(parser.isDone()).toBe(true);
    expect(parser.finish()).toMatchObject({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
  });

  it('drains a completed SSE response through EOF without cancelling it', async () => {
    const encoder = new TextEncoder();
    let cancelCount = 0;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const accumulator = new AgentCompletionResponseAccumulator('text/event-stream');
    accumulator.push(new TextDecoder().decode(first.value));

    expect(accumulator.isDone()).toBe(true);
    const draining = drainAgentCompletionStreamAfterDone(reader, 50);
    streamController?.close();
    await expect(draining).resolves.toBe('eof');
    expect(cancelCount).toBe(0);
    expect(accumulator.finish()).toMatchObject({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
  });

  it('cancels a completed SSE response only after the close grace expires', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let cancelReason: unknown;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ));
        },
        cancel(reason) {
          cancelReason = reason;
        },
      });
      const reader = stream.getReader();
      const first = await reader.read();
      const accumulator = new AgentCompletionResponseAccumulator('text/event-stream');
      accumulator.push(new TextDecoder().decode(first.value));

      expect(accumulator.isDone()).toBe(true);
      const draining = drainAgentCompletionStreamAfterDone(reader, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(draining).resolves.toBe('timeout');
      expect(cancelReason).toBeInstanceOf(Error);
      expect(accumulator.finish()).toMatchObject({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects SSE payloads when an upstream sends the wrong content type', () => {
    expect(looksLikeAgentSsePayload('data: {"choices":[]}\n\n')).toBe(true);
    expect(looksLikeAgentSsePayload(': keep-alive\n\n')).toBe(true);
    expect(looksLikeAgentSsePayload('{"data":{"value":"ok"}}')).toBe(false);

    const accumulator = new AgentCompletionResponseAccumulator('application/json');
    accumulator.push('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
    accumulator.push('data: [DONE]');
    expect(accumulator.isDone()).toBe(true);
    expect(accumulator.finish()).toMatchObject({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
  });

  it('does not parse tool arguments until all SSE fragments are aggregated', () => {
    const parser = new AgentCompletionSseParser();
    parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"canvas_","arguments":"{\\"x\\":"}}]},"finish_reason":null}]}\n\n');
    parser.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"add","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    const result = parser.finish() as { choices: Array<{ message: { tool_calls: unknown[] } }> };
    expect(result.choices[0]?.message.tool_calls).toEqual([{
      id: 'call_a',
      type: 'function',
      function: { name: 'canvas_add', arguments: '{"x":1}' },
    }]);
  });

  it('rejects an interrupted stream without DONE or a finish reason', () => {
    const parser = new AgentCompletionSseParser();
    parser.push('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    expect(() => parser.finish()).toThrow('ended unexpectedly');
  });

  it('keeps non-streaming JSON responses compatible', () => {
    const value = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    expect(parseAgentCompletionResponseText(JSON.stringify(value))).toEqual(value);

    const accumulator = new AgentCompletionResponseAccumulator('application/json');
    accumulator.push('{"choices":[{"message":{"content":');
    accumulator.push('"ok"},"finish_reason":"stop"}]}');
    expect(accumulator.isDone()).toBe(false);
    expect(accumulator.finish()).toEqual(value);
  });
});

describe('image analysis response compatibility', () => {
  it('recovers JSON from reasoning_content when content is empty', () => {
    const payloads = parseImageAnalysisResponsePayloads({
      choices: [{
        message: {
          content: '',
          reasoning_content: 'analysis complete\n```json\n{"tags":[{"name":"桌面音响","category":"产品类别","confidence":0.9}]}\n```',
        },
      }],
    });

    expect(payloads).toContainEqual({
      tags: [{ name: '桌面音响', category: '产品类别', confidence: 0.9 }],
    });
  });

  it('accepts object content and JSON surrounded by explanatory text', () => {
    expect(parseImageAnalysisResponsePayloads({
      choices: [{ message: { content: { tags: [{ name: '金属', category: '材质', confidence: 0.8 }] } } }],
    })).toContainEqual({ tags: [{ name: '金属', category: '材质', confidence: 0.8 }] });

    expect(parseImageAnalysisResponsePayloads({
      choices: [{ text: 'Result follows: {"colors":["黑色"],"style":["工业风"]} done.' }],
    })).toContainEqual({ colors: ['黑色'], style: ['工业风'] });
  });

  it('preserves streamed reasoning_content for the analysis fallback parser', () => {
    const parser = new AgentCompletionSseParser();
    parser.push('data: {"choices":[{"index":0,"delta":{"reasoning_content":"{\\"colors\\":[\\"银色\\"],"},"finish_reason":null}]}\n\n');
    parser.push('data: {"choices":[{"index":0,"delta":{"reasoning_content":"\\"style\\":[\\"极简主义\\"]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const payloads = parseImageAnalysisResponsePayloads(parser.finish());
    expect(payloads).toContainEqual({ colors: ['银色'], style: ['极简主义'] });
  });
});
