import {
  configuredImagesApiFields,
  editEndpoint,
  generationEndpoint,
  serializeConfiguredReferences,
} from './images-api-config.js';
import { isGptImage25Identity } from '../image-execution.js';
import { ImageAdapterError, imageAdapterConfig, type ImageModelAdapter } from './types.js';

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
    if (input.references.length && config.referenceRequestCount !== undefined
      && input.count !== config.referenceRequestCount) {
      throw new ImageAdapterError('IMAGE_ADAPTER_CONFIG_INVALID',
        '该路由的参考图请求每次只支持 1 组任务，请将生成数量设为 1。');
    }
    const endpoint = genericOpenAiImageUsesNativeEdit(input.references, input.capabilities)
      ? editEndpoint(config)
      : generationEndpoint(config);
    const nativeTransparentPng = input.background === 'transparent' && input.outputFormat === 'png'
      && (input.capabilities as { supportsTransparentBackground?: unknown } | undefined)?.supportsTransparentBackground === true
      && isGptImage25Identity(input.canonicalModelKey, input.upstreamModel);
    const body = {
      model: input.upstreamModel,
      prompt: input.prompt,
      ...(input.count > 1 ? { n: input.count } : {}),
      ...(input.references.length && config.referenceRequestCount !== undefined
        ? { n: config.referenceRequestCount } : {}),
      ...(input.references.length && config.referenceResponseFormat !== undefined
        ? { response_format: config.referenceResponseFormat } : {}),
      ...configuredFields,
      ...(nativeTransparentPng ? { background: 'transparent', output_format: 'png' } : {}),
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
