import {
  ImageAdapterError,
  adapterEndpoint,
  imageAdapterConfig,
  type ImageAdapterConfig,
  type ImageAdapterInput,
} from './types.js';

const resolutionLabel = (value: string | undefined) => value?.trim().toUpperCase() ?? '';

function exactDimension(
  config: ImageAdapterConfig,
  resolution: string,
  aspectRatio: string,
) {
  const byResolution = config.exactDimensions?.[resolution]
    ?? config.exactDimensions?.[resolution.toLowerCase()];
  const value = byResolution?.[aspectRatio];
  if (typeof value !== 'string' || !/^\d+x\d+$/i.test(value.trim())) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `No exact dimension mapping is configured for ${resolution} ${aspectRatio}`,
    );
  }
  return value.trim();
}

/** Route opt-in limits, also called before reading references or reserving credits. */
export function validateConfiguredImagesInput(input: Pick<ImageAdapterInput, 'prompt' | 'references' | 'count' | 'capabilities'>, config: ImageAdapterConfig) {
  const capabilities = input.capabilities && typeof input.capabilities === 'object'
    ? input.capabilities as Record<string, unknown> : {};
  let maximum = config.referenceSerializer === 'multipart_image_array' ? config.maxReferenceImages ?? 9 : 9;
  if (config.maxReferenceImages !== undefined) maximum = Math.min(maximum, config.maxReferenceImages);
  if (typeof capabilities.maxReferenceImages === 'number') maximum = Math.min(maximum, capabilities.maxReferenceImages);
  if (capabilities.supportsReferenceImages === false || capabilities.supportsReferenceImage === false) maximum = 0;
  if (input.references.length > maximum) throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID',
    `This image route accepts at most ${maximum} reference images; received ${input.references.length}`);
  if (config.referenceSerializer === 'json_image' && input.references.length > 1) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'The configured json_image serializer accepts exactly one reference image');
  }
  if (config.maxPromptCharacters !== undefined && Array.from(input.prompt).length > config.maxPromptCharacters) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', `Prompt exceeds the configured ${config.maxPromptCharacters} character limit`);
  }
  if (config.referenceSerializer === 'multipart_image_array' && input.references.length && capabilities.supportsImageEdit === false) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'This route does not support reference image edits');
  }
  if (config.referenceSerializer === 'multipart_image_array' && input.count !== 1) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Multipart image-array routes output exactly one image per request');
  }
  if (config.referenceSerializer === 'multipart_image_array' && !input.prompt.trim()) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Prompt must not be empty');
  }
  if (config.referenceSerializer === 'multipart_image_array'
    && (config.requestParameters?.n !== undefined && input.count !== config.requestParameters.n
      || input.references.length > 0 && config.referenceRequestCount !== undefined && input.count !== config.referenceRequestCount)) {
    throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID', 'Requested output count does not match the configured route count');
  }
}

export function configuredImagesApiFields(input: ImageAdapterInput) {
  const config = imageAdapterConfig(input.adapterConfig);
  validateConfiguredImagesInput(input, config);
  const body: Record<string, unknown> = {};
  const parameter = config.resolutionParameter ?? 'none';
  const mode = config.resolutionValueMode ?? 'label';
  const label = resolutionLabel(input.resolution);
  if (parameter !== 'none' && label) {
    body[parameter] = mode === 'exact'
      ? exactDimension(config, label, input.aspectRatio)
      : label;
  }
  if ((config.aspectRatioParameter ?? 'none') === 'aspect_ratio') {
    body.aspect_ratio = input.aspectRatio;
  }
  if (typeof config.async === 'boolean') body.async = config.async;
  return { config, body };
}

export function serializeConfiguredReferences(
  body: Record<string, unknown>,
  references: string[],
  config: ImageAdapterConfig,
  endpoint: string,
) {
  if (references.length === 0 || config.referenceSerializer === 'multipart_image_array') return;
  if (config.referenceSerializer === 'json_image') {
    if (references.length !== 1) {
      throw new ImageAdapterError(
        'IMAGE_ADAPTER_CONFIG_INVALID',
        'The configured json_image serializer accepts exactly one reference image',
        endpoint,
      );
    }
    body.image = references[0];
    return;
  }
  if (config.referenceSerializer === 'json_images') {
    body.images = references;
    return;
  }
  if (config.referenceSerializer === 'object_image_url') {
    body.images = references.map(image_url => ({ image_url }));
    return;
  }
  throw new ImageAdapterError(
    'PROVIDER_REFERENCE_EDIT_UNSUPPORTED',
    'The selected image route has no confirmed reference image serializer',
    endpoint,
  );
}

export function generationEndpoint(config: ImageAdapterConfig) {
  return adapterEndpoint(config.generationEndpoint, '/v1/images/generations');
}

export function editEndpoint(config: ImageAdapterConfig) {
  return adapterEndpoint(config.editEndpoint, '/v1/images/edits');
}
