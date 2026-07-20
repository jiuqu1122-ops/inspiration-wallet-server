import { describe, expect, it } from 'vitest';
import {
  buildAgentModelCandidates,
  buildSingleProviderAgentRetryModels,
  AgentCompletionSseParser,
  isAgentProtocolFallbackStatus,
  isAgentProviderFallbackStatus,
  isAgentProviderRetryStatus,
  isDefaultAgentModelSentinel,
  isLikelyAgentTextModel,
  getAgentRequestCredits,
  parseAgentCompletionResponseText,
  resolveConfiguredAgentModel,
  sanitizeAgentUpstreamDetail,
} from '../src/modules/ai/service.js';

describe('Agent provider fallback policy', () => {
  it('charges ten server-side credits for each Agent request', () => {
    expect(getAgentRequestCredits()).toBe(10n);
  });

  it('uses the configured channel model for default model sentinels', () => {
    expect(isDefaultAgentModelSentinel(undefined)).toBe(true);
    expect(isDefaultAgentModelSentinel('unmind-agent')).toBe(true);
    expect(isDefaultAgentModelSentinel('recommended')).toBe(true);
    expect(isDefaultAgentModelSentinel('gpt-5.6-sol')).toBe(false);
  });

  it('keeps the selected model on the primary channel and uses fallback channel defaults', () => {
    const primary = { defaultModel: 'primary-default' };
    const fallback = { defaultModel: 'fallback-default' };

    expect(resolveConfiguredAgentModel(primary, 'selected-model')).toBe('selected-model');
    expect(resolveConfiguredAgentModel(fallback, 'selected-model', true)).toBe('fallback-default');
    expect(resolveConfiguredAgentModel({ defaultModel: null }, 'selected-model', true)).toBe('selected-model');
  });

  it('falls back for gateway failures and protocol-specific channel errors', () => {
    expect(isAgentProviderFallbackStatus(524)).toBe(true);
    expect(isAgentProviderFallbackStatus(502)).toBe(true);
    expect(isAgentProviderFallbackStatus(429)).toBe(true);
    expect(isAgentProtocolFallbackStatus(404)).toBe(true);
    expect(isAgentProviderFallbackStatus(409)).toBe(false);
  });

  it('retries transient gateway errors without retrying protocol failures', () => {
    expect(isAgentProviderRetryStatus(504)).toBe(true);
    expect(isAgentProviderRetryStatus(524)).toBe(true);
    expect(isAgentProviderRetryStatus(503)).toBe(true);
    expect(isAgentProviderRetryStatus(429)).toBe(false);
    expect(isAgentProviderRetryStatus(400)).toBe(false);
    expect(isAgentProviderRetryStatus(401)).toBe(false);
  });

  it('selects another text model from the same channel after a model failure', () => {
    expect(buildAgentModelCandidates(
      { defaultModel: 'claude-sonnet-4-5' },
      'gemini-2.5-pro',
      [
        'gemini-3-pro-image-preview',
        'text-embedding-3-large',
        'gemini-2.5-flash',
        'claude-sonnet-4-5',
      ],
    )).toEqual([
      'gemini-2.5-pro',
      'claude-sonnet-4-5',
      'gemini-2.5-flash',
    ]);
  });

  it('retries a transient model before trying multiple same-channel alternatives', () => {
    expect(buildSingleProviderAgentRetryModels(
      { defaultModel: 'gpt-5.6-sol' },
      'unmind-agent',
      ['gpt-5.6-sol', 'gpt-5.4', 'gemini-2.5-pro', 'gpt-image-2'],
      'gpt-5.6-sol',
      true,
    )).toEqual(['gpt-5.6-sol', 'gpt-5.4', 'gemini-2.5-pro']);
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
  });
});
