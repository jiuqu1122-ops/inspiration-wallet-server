ALTER TABLE "AiUpstreamDiscovery"
ADD COLUMN "modalityOverride" TEXT;

ALTER TABLE "AiUpstreamDiscovery"
ADD CONSTRAINT "AiUpstreamDiscovery_modalityOverride_check"
CHECK ("modalityOverride" IS NULL OR "modalityOverride" IN ('chat', 'image', 'video'));
