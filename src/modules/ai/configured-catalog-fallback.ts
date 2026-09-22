/**
 * An upstream /v1/models failure is not a configuration deletion.
 * Callers MUST supply only routes which already passed the existing published,
 * enabled, visible, active-channel and capability checks. No historical union.
 */
export function configuredCatalogFallback<T>(
  configuredModels: readonly string[],
  capabilities: Readonly<Record<string, T>>,
  configuredDefault: string | null | undefined,
): { models: string[]; defaultModel: string | null; modelCapabilities: Record<string, T> } {
  // Exact public SKU IDs: gpt-image-2.5 and gpt-image-2.5-high stay distinct.
  const models = Array.from(new Set(configuredModels.map(id => id.trim()).filter(Boolean)));
  const preferred = String(configuredDefault ?? '').trim();
  const modelCapabilities: Record<string, T> = Object.fromEntries(
    models.flatMap(id => Object.prototype.hasOwnProperty.call(capabilities, id)
      ? [[id, capabilities[id]!] as const]
      : []),
  );
  return {
    models,
    defaultModel: models.includes(preferred) ? preferred : (models[0] ?? null),
    modelCapabilities,
  };
}
