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

export function configuredImagesApiFields(input: ImageAdapterInput) {
  const config = imageAdapterConfig(input.adapterConfig);
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
  if (references.length === 0) return;
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
