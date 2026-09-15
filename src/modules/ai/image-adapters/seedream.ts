import {
  configuredImagesApiFields,
  editEndpoint,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import {
  assertAdapterModelFamily,
  type ImageModelAdapter,
} from './types.js';

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
      prompt: input.prompt,
      ...(input.count > 1 ? { n: input.count } : {}),
      ...configuredFields,
    };
    serializeConfiguredReferences(body, input.references, config, endpoint);
    return {
      adapterKey: 'SEEDREAM_IMAGES_API',
      endpoint,
      method: 'POST',
      contentType: 'application/json',
      body,
      asyncMode: config.async === true ? 'task' : 'provider',
    };
  },
};
