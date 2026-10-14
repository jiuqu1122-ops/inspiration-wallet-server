export type ImageOutputCapabilities = {
  supportedQualities: string[];
  qualityParameter: string;
  outputMode: 'single_asset' | 'multiple_assets';
  maxOutputImages: number;
  billingMode?: 'per_request' | 'per_image';
};

export function resolveImageOutputCapabilities(value: unknown): ImageOutputCapabilities {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    supportedQualities: Array.isArray(source.supportedQualities)
      ? [...new Set(source.supportedQualities.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))] : [],
    qualityParameter: typeof source.qualityParameter === 'string' && source.qualityParameter.trim()
      ? source.qualityParameter.trim() : 'quality',
    outputMode: source.outputMode === 'multiple_assets' ? 'multiple_assets' : 'single_asset',
    maxOutputImages: Math.max(1, Math.min(16, Math.floor(Number(source.maxOutputImages ?? source.maxOutputs) || 1))),
    ...(source.billingMode === 'per_request' || source.billingMode === 'per_image' ? { billingMode: source.billingMode } : {}),
  };
}

export function imageQualityFields(capabilities: unknown, quality?: string) {
  const config = resolveImageOutputCapabilities(capabilities);
  if (!config.supportedQualities.length || !quality) return {};
  if (!config.supportedQualities.includes(quality)) throw new Error('Unsupported image quality');
  return { [config.qualityParameter]: quality };
}

export function imageResultLimit(capabilities: unknown, requestedCount: number) {
  const config = resolveImageOutputCapabilities(capabilities);
  return config.outputMode === 'multiple_assets' ? config.maxOutputImages : requestedCount;
}
