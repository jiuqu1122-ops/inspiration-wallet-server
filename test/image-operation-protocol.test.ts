import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  imageOperationInputSchema, validateImageOperationInput, validateImageOperationMask,
  parseImageOperationContext, imageOperationProviderFingerprint,
} from '../src/modules/ai/image-operation-protocol.js';
import { IMAGE_OPERATIONS } from '../src/modules/ai/image-operation-pricing.js';

const base = { userId: 'owner', clientRequestId: 'operation-0001', model: 'configured-model', operation: 'imagine' as const, prompt: 'Original prompt' };
const validate = (value: unknown) => validateImageOperationInput(imageOperationInputSchema.parse(value));

describe('image operation input contract', () => {
  it('accepts all eighteen exact operation spellings without aliasing subtle/subtile', () => {
    expect(IMAGE_OPERATIONS).toHaveLength(18);
    for (const operation of IMAGE_OPERATIONS) {
      expect(imageOperationInputSchema.parse({ ...base, operation }).operation).toBe(operation);
    }
    expect(imageOperationInputSchema.safeParse({ ...base, operation: 'upscale_subtil' }).success).toBe(false);
  });

  it.each(['x', 'x'.repeat(129)])('bounds request IDs: %s', clientRequestId => {
    expect(imageOperationInputSchema.safeParse({ ...base, clientRequestId }).success).toBe(false);
  });

  it('rejects unknown provider, task, charge, host, size and resolution overrides', () => {
    for (const key of ['providerId', 'taskId', 'chargedCredits', 'baseUrl', 'size', 'resolution', 'quality']) {
      expect(imageOperationInputSchema.safeParse({ ...base, [key]: 'forged' }).success).toBe(false);
    }
  });

  it('validates reference counts before any network work', () => {
    expect(() => validate({ ...base, inputImages: Array(6).fill('data:image/png;base64,AAAA') })).toThrow();
    expect(() => validate({ ...base, operation: 'blend', prompt: undefined, inputImages: ['one'] })).toThrow('two to five');
    expect(() => validate({ ...base, operation: 'blend', prompt: undefined, inputImages: ['one', 'two'], dimensions: 'PORTRAIT' })).not.toThrow();
    expect(() => validate({ ...base, operation: 'describe', prompt: undefined, inputImages: ['one', 'two'] })).toThrow('one image');
    expect(() => validate({ ...base, operation: 'uploads', prompt: undefined })).toThrow('one to five');
  });

  it('requires original prompts for imagine and shorten', () => {
    for (const operation of ['imagine', 'shorten']) expect(() => validate({ ...base, operation, prompt: ' ' })).toThrow('requires a prompt');
    expect(() => validate({ ...base, operation: 'shorten', inputImages: ['one'] })).toThrow('does not accept images');
  });

  it('rejects using an initial request as an action or replacing a parent image', () => {
    expect(() => validate({ ...base, actionId: 'forged' })).toThrow('cannot use a parent');
    expect(() => validate({ ...base, operation: 'upscale' })).toThrow('owned parent');
    expect(() => validate({ ...base, operation: 'upscale', parentClientRequestId: base.clientRequestId, actionId: 'actual' })).toThrow('new request ID');
    expect(() => validate({ ...base, operation: 'upscale', parentClientRequestId: 'parent-request', actionId: 'actual', inputImages: ['one'] })).toThrow('cannot replace');
  });

  it('keeps dimensions/aspect and second-step mask/zoom on their documented operations', () => {
    expect(() => validate({ ...base, dimensions: 'LANDSCAPE' })).toThrow('only supported by blend');
    expect(() => validate({ ...base, operation: 'shorten', aspectRatio: '16:9' })).toThrow('only supported by imagine');
    expect(() => validate({ ...base, operation: 'inpaint', parentClientRequestId: 'parent-request', actionId: 'actual', maskBase64: 'data:image/png;base64,AAAA' })).toThrow('second modal');
    expect(imageOperationInputSchema.safeParse({ ...base, zoom: 2.1 }).success).toBe(false);
  });
});

describe('image operation private parent context', () => {
  const context = {
    version: 1, protocol: 'GENERIC_TASK', providerId: 'provider', routeId: 'route', submittedModel: 'model',
    taskId: 'opaque-task', operation: 'inpaint', speed: 'fast',
    originalImageDimensions: { width: 1024, height: 768 },
    providerConnectionFingerprint: 'f'.repeat(64),
  };
  it('preserves original dimensions for an empty modal window without accepting unknown context', () => {
    expect(parseImageOperationContext({ ...context, token: 'never-public' })).toEqual(context);
    expect(parseImageOperationContext({ ...context, imageDimensions: { width: 0, height: 1 } })).toEqual(context);
  });
  it.each([
    { taskId: '' }, { operation: 'invented' }, { speed: 'invented' }, { protocol: 'USELG_IMAGE_TASK' }, { version: 2 },
  ])('rejects incomplete or foreign protocol context: %j', patch => {
    expect(parseImageOperationContext({ ...context, ...patch })).toBeUndefined();
  });
  it('pins provider endpoint and encrypted account without exposing either in the fingerprint', () => {
    const source = { baseUrl: 'https://provider.example', encryptedSecrets: 'private-ciphertext' };
    const hash = imageOperationProviderFingerprint(source);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(imageOperationProviderFingerprint(source)).toBe(hash);
    expect(imageOperationProviderFingerprint({ ...source, baseUrl: 'https://other.example' })).not.toBe(hash);
    expect(imageOperationProviderFingerprint({ ...source, encryptedSecrets: 'other-account' })).not.toBe(hash);
  });
});

describe('image operation opaque grayscale masks', () => {
  const encode = async (pixels: number[], width: number, height = 1) => `data:image/png;base64,${(await sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 },
  }).png().toBuffer()).toString('base64')}`;

  it('accepts full original-size opaque grayscale PNG with white edit pixels', async () => {
    const mask = await encode([0, 0, 0, 255, 255, 255, 255, 255], 2);
    await expect(validateImageOperationMask(mask, { width: 2, height: 1 })).resolves.toBe(mask);
  });
  it('rejects the reference/window dimensions instead of the original source dimensions', async () => {
    const mask = await encode([255, 255, 255, 255], 1);
    await expect(validateImageOperationMask(mask, { width: 2, height: 1 })).rejects.toThrow('original result');
  });
  it.each([
    [[255, 255, 255, 0], 'fully opaque'],
    [[255, 0, 255, 255], 'grayscale'],
    [[0, 0, 0, 255], 'white edit area'],
  ] as const)('rejects invalid mask pixels %j', async (pixels, message) => {
    await expect(validateImageOperationMask(await encode([...pixels], 1), { width: 1, height: 1 })).rejects.toThrow(message);
  });
  it.each(['https://private.example/mask.png', 'data:image/jpeg;base64,AAAA', 'data:image/png;base64,AAAA'])('rejects URLs, wrong formats and invalid image bytes', async value => {
    await expect(validateImageOperationMask(value, { width: 1, height: 1 })).rejects.toThrow();
  });
});
