import {
  assertAdapterModelFamily,
  type ImageModelAdapter,
} from './types.js';

export const nanoBananaAdapter: ImageModelAdapter = {
  key: 'NANO_BANANA',
  execution: 'legacy',
  validateModel(upstreamModel) {
    assertAdapterModelFamily(
      'NANO_BANANA',
      upstreamModel,
      /(?:gemini.*image|nano[-_.\s]?banana|nano[-_.\s]?pro|nano[-_.\s]?2)/i,
    );
  },
};
