import {
  configuredImagesApiFields,
  editEndpoint,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import {
  assertAdapterModelFamily,
  type ImageAdapterConfig,
  type ImageModelAdapter,
} from './types.js';

export function usesSeedreamReferences(adapterKey: string, upstreamModel: string) {
  return adapterKey === 'SEEDREAM_IMAGES_API'
    || (adapterKey === 'GENERIC_OPENAI_IMAGE' && /^seedream(?:[-_.\s]|$)/i.test(upstreamModel.trim()));
}

export function seedreamReferenceTransport(config: ImageAdapterConfig) {
  // The channel's published contract confirms public URLs but does not confirm
  // Data URLs. Inline bytes are used only when the route explicitly opts in.
  return config.referenceTransport ?? 'public_https';
}

export const seedreamImagesApiAdapter: ImageModelAdapter = {
  key: 'SEEDREAM_IMAGES_API',
  execution: 'images-api',
  validateModel(upstreamModel) {
    assertAdapterModelFamily(
      'SEEDREAM_IMAGES_API',
      upstreamModel,
      /seedream/i,
    );
  },
  buildRequest(input) {
    const { config, body: configuredFields } = configuredImagesApiFields(input);
    const endpoint = input.references.length > 0
      ? editEndpoint(config)
      : generationEndpoint(config);
    const body = {
      model: input.upstreamModel,
      ...(config.referenceSerializer === 'multipart_image_array' ? { n: 1, response_format: config.referenceResponseFormat ?? 'url' } : {}),
      prompt: input.prompt,
      ...(input.count > 1 ? { n: input.count } : {}),
      ...configuredFields,
      ...(config.referenceSerializer === 'multipart_image_array' ? config.requestParameters : {}),
    };
    serializeConfiguredReferences(body, input.references, config, endpoint);
    return {
      adapterKey: 'SEEDREAM_IMAGES_API',
      execution: 'images-api',
      submittedModel: input.upstreamModel,
      endpoint,
      method: 'POST',
      contentType: input.references.length && config.referenceSerializer === 'multipart_image_array'
        ? 'multipart/form-data' : 'application/json',
      ...(input.references.length && config.referenceSerializer === 'multipart_image_array'
        ? { fileReferences: input.references } : {}),
      body,
    };
  },
};
