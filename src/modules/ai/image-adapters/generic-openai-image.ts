import {
  configuredImagesApiFields,
  editEndpoint,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import { imageAdapterConfig, type ImageModelAdapter } from './types.js';

export function genericOpenAiImageUsesNativeEdit(references: readonly string[], capabilities: unknown) {
  return references.length > 0
    && (capabilities as { supportsImageEdit?: boolean } | undefined)?.supportsImageEdit !== false;
}

/** An independent task endpoint owns its reference contract. Only replace the
 * ordinary generation endpoint with its matching native edit endpoint. */
export function genericOpenAiImageTaskUsesNativeEdit(
  references: readonly string[],
  capabilities: unknown,
  adapterConfig: unknown,
  submitEndpoint: string,
) {
  return genericOpenAiImageUsesNativeEdit(references, capabilities)
    && submitEndpoint === generationEndpoint(imageAdapterConfig(adapterConfig));
}

export const genericOpenAiImageAdapter: ImageModelAdapter = {
  key: 'GENERIC_OPENAI_IMAGE',
  execution: 'images-api',
  buildRequest(input) {
    const { config, body: configuredFields } = configuredImagesApiFields(input);
    const endpoint = genericOpenAiImageUsesNativeEdit(input.references, input.capabilities)
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
    };
  },
};
