-- Extend the existing discovery override constraint without changing stored rows.
-- A new migration is required because the earlier AUDIO migration may be applied.
ALTER TABLE "AiUpstreamDiscovery"
  DROP CONSTRAINT IF EXISTS "AiUpstreamDiscovery_modalityOverride_check",
  ADD CONSTRAINT "AiUpstreamDiscovery_modalityOverride_check"
    CHECK ("modalityOverride" IS NULL OR "modalityOverride" IN ('chat', 'image', 'video', 'audio'));
