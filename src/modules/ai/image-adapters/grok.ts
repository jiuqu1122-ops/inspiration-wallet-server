import {
  configuredImagesApiFields,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import {
  assertAdapterModelFamily,
  type ImageModelAdapter,
} from './types.js';

export const grokImagesApiAdapter: ImageModelAdapter = {
  key: 'GROK_IMAGES_API',
  execution: 'images-api',
  validateModel(upstreamModel) {
    assertAdapterModelFamily(
      'GROK_IMAGES_API',
      upstreamModel,
      /grok/i,
    );
  },
  buildRequest(input) {
    const { config, body: configuredFields } = configuredImagesApiFields(input);
    const endpoint = generationEndpoint(config);
    const body = {
      model: input.upstreamModel,
      prompt: input.prompt,
      ...(input.count > 1 ? { n: input.count } : {}),
      ...configuredFields,
    };
    serializeConfiguredReferences(body, input.references, config, endpoint);
    return {
      adapterKey: 'GROK_IMAGES_API',
      execution: 'images-api',
      submittedModel: input.upstreamModel,
      endpoint,
      method: 'POST',
      contentType: 'application/json',
      body,
    };
  },
};
