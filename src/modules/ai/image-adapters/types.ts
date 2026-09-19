export const IMAGE_ADAPTER_KEYS = [
  'LEGACY',
  'GPT_IMAGE',
  'NANO_BANANA',
  'GEMINI_NATIVE_IMAGE',
  'SEEDREAM_IMAGES_API',
  'GROK_IMAGES_API',
  'GENERIC_OPENAI_IMAGE',
] as const;

export type ImageAdapterKey = typeof IMAGE_ADAPTER_KEYS[number];

export type ImageAdapterConfig = {
  resolutionParameter?: 'none' | 'size' | 'resolution';
  resolutionValueMode?: 'label' | 'exact';
  aspectRatioParameter?: 'none' | 'aspect_ratio';
  async?: 'inherit' | boolean;
  generationEndpoint?: string;
  editEndpoint?: string;
  exactDimensions?: Record<string, Record<string, string>>;
  referenceSerializer?: 'json_image' | 'json_images';
};

export type ImageAdapterInput = {
  requestedCanonicalModel: string;
  resolvedCanonicalModel: string;
  canonicalModelId: string;
  canonicalModelKey: string;
  routeId: string;
  channelId: string;
  upstreamModel: string;
  prompt: string;
  negativePrompt?: string;
  references: string[];
  resolution?: string;
  aspectRatio: string;
  count: number;
  outputFormat: 'jpg' | 'jpeg' | 'png' | 'webp';
  background?: 'transparent';
  adapterConfig?: unknown;
};

export type PreparedImageAdapterRequest = {
  adapterKey: ImageAdapterKey;
  execution: 'images-api' | 'gemini-native';
  submittedModel: string;
  endpoint: string;
  method: 'POST';
  contentType: 'application/json';
  body: Record<string, unknown>;
};

export interface ImageModelAdapter {
  readonly key: ImageAdapterKey;
  readonly execution: 'legacy' | 'images-api' | 'gemini-native';
  validateModel?(upstreamModel: string): void;
  buildRequest?(input: ImageAdapterInput): PreparedImageAdapterRequest;
}

export class ImageAdapterError extends Error {
  constructor(
    public readonly code:
      | 'IMAGE_ADAPTER_CONFIG_INVALID'
      | 'IMAGE_ADAPTER_MODEL_MISMATCH'
      | 'IMAGE_MODEL_IDENTITY_MISMATCH'
      | 'PROVIDER_REFERENCE_EDIT_UNSUPPORTED',
    message: string,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'ImageAdapterError';
  }
}

export function imageAdapterConfig(value: unknown): ImageAdapterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const config: ImageAdapterConfig = {};
  const allowed = new Set([
    'resolutionParameter',
    'resolutionValueMode',
    'aspectRatioParameter',
    'async',
    'generationEndpoint',
    'editEndpoint',
    'exactDimensions',
    'referenceSerializer',
  ]);
  const unknown = Object.keys(source).find(key => !allowed.has(key));
  if (unknown) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `Unsupported image adapter configuration field: ${unknown}`,
    );
  }
  if (source.resolutionParameter !== undefined) {
    if (source.resolutionParameter === 'none'
      || source.resolutionParameter === 'size'
      || source.resolutionParameter === 'resolution') {
      config.resolutionParameter = source.resolutionParameter;
    } else throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid resolutionParameter');
  }
  if (source.resolutionValueMode !== undefined) {
    if (source.resolutionValueMode === 'label' || source.resolutionValueMode === 'exact') {
      config.resolutionValueMode = source.resolutionValueMode;
    } else throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid resolutionValueMode');
  }
  if (source.aspectRatioParameter !== undefined) {
    if (source.aspectRatioParameter === 'none' || source.aspectRatioParameter === 'aspect_ratio') {
      config.aspectRatioParameter = source.aspectRatioParameter;
    } else throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid aspectRatioParameter');
  }
  if (source.async !== undefined) {
    if (source.async === true || source.async === false || source.async === 'inherit') {
      config.async = source.async;
    } else throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid async adapter setting');
  }
  for (const key of ['generationEndpoint', 'editEndpoint'] as const) {
    const endpoint = source[key];
    if (endpoint === undefined) continue;
    if (typeof endpoint !== 'string') {
      throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', `Invalid ${key}`);
    }
    config[key] = endpoint;
  }
  if (source.exactDimensions !== undefined) {
    if (!source.exactDimensions || typeof source.exactDimensions !== 'object' || Array.isArray(source.exactDimensions)) {
      throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid exactDimensions');
    }
    const exactDimensions: Record<string, Record<string, string>> = {};
    for (const [resolution, rawMapping] of Object.entries(source.exactDimensions)) {
      if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
        throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', `Invalid exactDimensions mapping for ${resolution}`);
      }
      exactDimensions[resolution] = {};
      for (const [aspectRatio, dimension] of Object.entries(rawMapping as Record<string, unknown>)) {
        if (typeof dimension !== 'string' || !/^\d+x\d+$/i.test(dimension.trim())) {
          throw new ImageAdapterError(
            'IMAGE_ADAPTER_CONFIG_INVALID',
            `Invalid exact dimension for ${resolution} ${aspectRatio}`,
          );
        }
        exactDimensions[resolution][aspectRatio] = dimension.trim();
      }
    }
    config.exactDimensions = exactDimensions;
  }
  if (source.referenceSerializer !== undefined) {
    if (source.referenceSerializer === 'json_image' || source.referenceSerializer === 'json_images') {
      config.referenceSerializer = source.referenceSerializer;
    } else throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Invalid referenceSerializer');
  }
  return config;
}

export function adapterEndpoint(value: unknown, fallback: string) {
  const endpoint = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `Image adapter endpoint must be an absolute provider path: ${endpoint}`,
    );
  }
  return endpoint;
}

export function assertPreparedImageIdentity(
  input: Pick<ImageAdapterInput, 'requestedCanonicalModel' | 'resolvedCanonicalModel' | 'upstreamModel'>,
  prepared: PreparedImageAdapterRequest,
) {
  if (input.requestedCanonicalModel.trim().toLowerCase()
    !== input.resolvedCanonicalModel.trim().toLowerCase()) {
    throw new ImageAdapterError(
      'IMAGE_MODEL_IDENTITY_MISMATCH',
      `Requested canonical model ${input.requestedCanonicalModel} resolved as ${input.resolvedCanonicalModel}`,
    );
  }
  if (prepared.submittedModel !== input.upstreamModel) {
    throw new ImageAdapterError(
      'IMAGE_MODEL_IDENTITY_MISMATCH',
      `Prepared upstream model ${prepared.submittedModel} does not match route model ${input.upstreamModel}`,
      prepared.endpoint,
    );
  }
  if (prepared.execution === 'images-api' && prepared.body.model !== input.upstreamModel) {
    throw new ImageAdapterError(
      'IMAGE_MODEL_IDENTITY_MISMATCH',
      `Prepared Images API request model does not match route model ${input.upstreamModel}`,
      prepared.endpoint,
    );
  }
  const expectedGeminiEndpoint = `/v1beta/models/${encodeURIComponent(input.upstreamModel)}:generateContent`;
  if (prepared.execution === 'gemini-native' && prepared.endpoint !== expectedGeminiEndpoint) {
    throw new ImageAdapterError(
      'IMAGE_MODEL_IDENTITY_MISMATCH',
      `Prepared Gemini endpoint ${prepared.endpoint} does not match route model ${input.upstreamModel}`,
      prepared.endpoint,
    );
  }
}

export function assertAdapterModelFamily(
  adapterKey: ImageAdapterKey,
  upstreamModel: string,
  expected: RegExp,
) {
  const model = upstreamModel.trim();
  if (expected.test(model)) return;
  throw new ImageAdapterError(
    'IMAGE_ADAPTER_MODEL_MISMATCH',
    `${adapterKey} conflicts with route upstream model ${upstreamModel}`,
  );
}
