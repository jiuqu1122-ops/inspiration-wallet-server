import { describe, expect, it } from 'vitest';
import {
  chooseProviderForCapability,
  resolveImageModel,
  resolveXaisModel,
  sizeFromRatio,
  uniqueImages,
} from '../src/modules/ai/image-service.js';

describe('wallet image provider normalization', () => {
  it('prefers the dedicated IMAGE channel over an LLM channel with legacy broad capabilities', () => {
    const llm = { name: 'codex', capabilities: ['LLM', 'IMAGE', 'VIDEO'] as const };
    const image = { name: 'newapi-image', capabilities: ['IMAGE'] as const };
    expect(chooseProviderForCapability([llm, image], 'IMAGE')).toBe(image);
    expect(chooseProviderForCapability([llm], 'IMAGE')).toBeUndefined();
  });

  it('uses the manager-configured image model instead of the client model', () => {
    expect(resolveImageModel({ defaultModel: 'gemini-3-pro-image' }))
      .toBe('gemini-3-pro-image');
    expect(() => resolveImageModel({ defaultModel: null }))
      .toThrow('生图渠道没有配置默认模型');
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
    expect(resolveXaisModel('custom-model')).toBe('custom-model');
  });

  it('uses stable OpenAI-compatible dimensions for supported ratios', () => {
    expect(sizeFromRatio('1:1')).toBe('1024x1024');
    expect(sizeFromRatio('16:9')).toBe('1792x1024');
    expect(sizeFromRatio('9:16')).toBe('1024x1792');
  });
});
