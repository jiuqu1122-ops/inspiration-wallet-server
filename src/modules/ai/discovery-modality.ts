import type { AiModality } from './model-catalog.js';

type DiscoveryModalityFields = {
  modalityOverride?: string | null;
  suggestedModality?: string | null;
};

export function storedAiModality(value: unknown): AiModality | null {
  return value === 'chat' || value === 'image' || value === 'video' ? value : null;
}

export function effectiveDiscoveryModality(discovery: DiscoveryModalityFields): AiModality | null {
  return storedAiModality(discovery.modalityOverride)
    ?? storedAiModality(discovery.suggestedModality);
}
