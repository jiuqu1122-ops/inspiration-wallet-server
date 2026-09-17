import {
  configuredImagesApiFields,
  editEndpoint,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import type { ImageModelAdapter } from './types.js';

export const genericOpenAiImageAdapter: ImageModelAdapter = {
  key: 'GENERIC_OPENAI_IMAGE',
  execution: 'images-api',
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
      adapterKey: 'GENERIC_OPENAI_IMAGE',
      execution: 'images-api',
      submittedModel: input.upstreamModel,
      endpoint,
      method: 'POST',
      contentType: 'application/json',
      body,
      asyncMode: config.async === true ? 'task' : 'provider',
    };
  },
};
