import {
  assertAdapterModelFamily,
  type ImageModelAdapter,
} from './types.js';

export const gptImageAdapter: ImageModelAdapter = {
  key: 'GPT_IMAGE',
  execution: 'legacy',
  validateModel(upstreamModel) {
    assertAdapterModelFamily(
      'GPT_IMAGE',
      upstreamModel,
      /(?:gpt[-_.\s]?image|image[-_.\s]?2|img[-_.\s]?2)/i,
    );
  },
};
