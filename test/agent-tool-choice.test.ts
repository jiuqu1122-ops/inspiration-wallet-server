import { describe, expect, it } from 'vitest';
import { buildAgentProviderRequestBody } from '../src/modules/ai/service.js';
import {
  agentTaskPayloadSchema,
  agentToolChoiceSchema,
  createAiTaskSchema,
} from '../src/modules/ai/task-schema.js';

const forcedImageVariants = {
  type: 'function' as const,
  function: { name: 'generate_image_variants' },
};

describe('Agent tool choice compatibility', () => {
  it('accepts a forced function choice in asynchronous Agent tasks', () => {
    expect(createAiTaskSchema.parse({
      type: 'agent_chat',
      requestId: 'chat-request-1234',
      payload: {
        messages: [{ role: 'user', content: '分别出图' }],
        tools: [{ type: 'function', function: { name: 'generate_image_variants' } }],
        toolChoice: forcedImageVariants,
      },
    }).payload).toMatchObject({ toolChoice: forcedImageVariants });
  });

  it('keeps legacy Agent payloads valid when toolChoice is absent', () => {
    expect(agentTaskPayloadSchema.parse({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })).not.toHaveProperty('toolChoice');
  });

  it('rejects malformed or over-specified function choices', () => {
    expect(agentToolChoiceSchema.safeParse({
      type: 'function',
      function: { name: '' },
    }).success).toBe(false);
    expect(agentToolChoiceSchema.safeParse({
      type: 'function',
      function: { name: 'generate_image', extra: true },
    }).success).toBe(false);
  });

  it('forwards a forced function choice to the upstream request', () => {
    expect(buildAgentProviderRequestBody({
      messages: [{ role: 'user', content: '分别出图' }],
      tools: [{ type: 'function', function: { name: 'generate_image_variants' } }],
      toolChoice: forcedImageVariants,
    })).toEqual({
      messages: [{ role: 'user', content: '分别出图' }],
      tools: [{ type: 'function', function: { name: 'generate_image_variants' } }],
      tool_choice: forcedImageVariants,
    });
  });

  it('defaults to auto for old clients and omits tool_choice without tools', () => {
    expect(buildAgentProviderRequestBody({
      messages: [],
      tools: [{ type: 'function' }],
    })).toMatchObject({ tool_choice: 'auto' });
    expect(buildAgentProviderRequestBody({
      messages: [],
      tools: [],
      toolChoice: forcedImageVariants,
    })).toEqual({ messages: [] });
  });
});
