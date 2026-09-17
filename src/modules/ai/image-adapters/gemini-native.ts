import {
  ImageAdapterError,
  assertAdapterModelFamily,
  type ImageModelAdapter,
} from './types.js';

function geminiImageSize(resolution?: string) {
  const normalized = String(resolution || '').trim().toUpperCase();
  return normalized === '1K' || normalized === '4K' ? normalized : '2K';
}

function geminiInlineImagePart(source: string) {
  const trimmed = source.trim();
  const separator = trimmed.indexOf(',');
  const header = separator >= 0 ? trimmed.slice(0, separator) : '';
  const match = header.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/i);
  if (!match || separator < 0) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Gemini Native image references must be materialized image data URIs',
    );
  }
  const encoded = trimmed.slice(separator + 1);
  if (!encoded) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Gemini Native image reference is empty',
    );
  }
  return {
    inlineData: {
      mimeType: match[1]!,
      data: /\s/.test(encoded) ? encoded.replace(/\s+/g, '') : encoded,
    },
  };
}

export const geminiNativeImageAdapter: ImageModelAdapter = {
  key: 'GEMINI_NATIVE_IMAGE',
  execution: 'gemini-native',
  validateModel(upstreamModel) {
    assertAdapterModelFamily(
      'GEMINI_NATIVE_IMAGE',
      upstreamModel,
      /(?:gemini.*image|nano[-_.\s]?banana|nano[-_.\s]?pro|nano[-_.\s]?2)/i,
    );
  },
  buildRequest(input) {
    if (input.adapterConfig !== undefined && input.adapterConfig !== null) {
      throw new ImageAdapterError(
        'IMAGE_ADAPTER_CONFIG_INVALID',
        'GEMINI_NATIVE_IMAGE does not accept Images API adapter configuration',
      );
    }
    return {
      adapterKey: 'GEMINI_NATIVE_IMAGE',
      execution: 'gemini-native',
      submittedModel: input.upstreamModel,
      endpoint: `/v1beta/models/${encodeURIComponent(input.upstreamModel)}:generateContent`,
      method: 'POST',
      contentType: 'application/json',
      body: {
        contents: [{
          role: 'user',
          parts: [
            { text: input.prompt },
            ...input.references.map(geminiInlineImagePart),
          ],
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: input.aspectRatio,
            imageSize: geminiImageSize(input.resolution),
          },
        },
      },
      asyncMode: 'provider',
    };
  },
};
