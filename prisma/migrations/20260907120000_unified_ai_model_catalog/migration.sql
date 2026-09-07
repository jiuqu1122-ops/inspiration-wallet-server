-- Additive, backwards-compatible model catalog and pricing center migration.
-- Existing wallet balances, ledger rows, AI request charges, and legacy pricing
-- configuration are intentionally left untouched. The application performs an
-- idempotent import of the effective legacy prices after this migration lands.

CREATE TABLE "AiModel" (
    "id" TEXT NOT NULL,
    "canonicalModelKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "billingType" TEXT NOT NULL,
    "routingMode" TEXT NOT NULL DEFAULT 'LEGACY',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "defaultRouteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiModelRoute" (
    "id" TEXT NOT NULL,
    "canonicalModelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channelId" TEXT,
    "upstreamModelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "upstreamAvailable" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "costProfile" JSONB,
    "capabilitiesOverride" JSONB,
    "metadata" JSONB,
    "pricingSyncStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "costUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiModelRoute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiModelAlias" (
    "id" TEXT NOT NULL,
    "canonicalModelId" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiModelAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiPriceVersion" (
    "id" TEXT NOT NULL,
    "canonicalModelId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "pricing" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiPriceVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiModelPricing" (
    "canonicalModelId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "pendingPrice" JSONB,
    "suggestedPrice" JSONB,
    "pricingMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "markupMultiplier" DECIMAL(12,6) NOT NULL DEFAULT 1.32,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiModelPricing_pkey" PRIMARY KEY ("canonicalModelId")
);

CREATE TABLE "AiUpstreamDiscovery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "upstreamModelId" TEXT NOT NULL,
    "suggestedModality" TEXT,
    "availability" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "capabilities" JSONB,
    "context" JSONB,
    "resolution" JSONB,
    "duration" JSONB,
    "discoveredCost" JSONB,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'UNMAPPED',
    "suggestedModelId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiUpstreamDiscovery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiRouteCostHistory" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "costProfile" JSONB NOT NULL,
    "pricingSyncStatus" TEXT NOT NULL DEFAULT 'OK',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiRouteCostHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AiRequest"
    ADD COLUMN "canonicalModelId" TEXT,
    ADD COLUMN "routeId" TEXT,
    ADD COLUMN "priceVersionId" TEXT,
    ADD COLUMN "pricingSnapshot" JSONB,
    ADD COLUMN "chargeBreakdown" JSONB;

CREATE TABLE "AiBillingSettlement" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "canonicalModelId" TEXT,
    "routeId" TEXT,
    "priceVersionId" TEXT,
    "chargedCredits" DECIMAL(24,6) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiBillingSettlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiBillingSettlement_nonnegative_credits" CHECK ("chargedCredits" >= 0)
);

CREATE UNIQUE INDEX "AiModel_canonicalModelKey_key" ON "AiModel"("canonicalModelKey");
CREATE UNIQUE INDEX "AiModel_defaultRouteId_key" ON "AiModel"("defaultRouteId");
CREATE INDEX "AiModel_modality_enabled_visible_sortOrder_idx" ON "AiModel"("modality", "enabled", "visible", "sortOrder");
CREATE INDEX "AiModel_status_modality_idx" ON "AiModel"("status", "modality");

CREATE UNIQUE INDEX "AiModelRoute_provider_channelId_upstreamModelId_key" ON "AiModelRoute"("provider", "channelId", "upstreamModelId");
CREATE INDEX "AiModelRoute_canonicalModelId_enabled_priority_idx" ON "AiModelRoute"("canonicalModelId", "enabled", "priority");
CREATE INDEX "AiModelRoute_channelId_enabled_priority_idx" ON "AiModelRoute"("channelId", "enabled", "priority");
CREATE INDEX "AiModelRoute_provider_upstreamModelId_idx" ON "AiModelRoute"("provider", "upstreamModelId");

CREATE UNIQUE INDEX "AiModelAlias_modality_aliasKey_key" ON "AiModelAlias"("modality", "aliasKey");
CREATE INDEX "AiModelAlias_canonicalModelId_idx" ON "AiModelAlias"("canonicalModelId");

CREATE UNIQUE INDEX "AiPriceVersion_canonicalModelId_version_key" ON "AiPriceVersion"("canonicalModelId", "version");
CREATE INDEX "AiPriceVersion_canonicalModelId_publishedAt_idx" ON "AiPriceVersion"("canonicalModelId", "publishedAt");
CREATE UNIQUE INDEX "AiModelPricing_currentVersionId_key" ON "AiModelPricing"("currentVersionId");

CREATE UNIQUE INDEX "AiUpstreamDiscovery_channelId_upstreamModelId_key" ON "AiUpstreamDiscovery"("channelId", "upstreamModelId");
CREATE INDEX "AiUpstreamDiscovery_status_lastSyncedAt_idx" ON "AiUpstreamDiscovery"("status", "lastSyncedAt");
CREATE INDEX "AiUpstreamDiscovery_provider_upstreamModelId_idx" ON "AiUpstreamDiscovery"("provider", "upstreamModelId");
CREATE INDEX "AiRouteCostHistory_routeId_observedAt_idx" ON "AiRouteCostHistory"("routeId", "observedAt");

CREATE INDEX "AiRequest_canonicalModelId_createdAt_idx" ON "AiRequest"("canonicalModelId", "createdAt");
CREATE INDEX "AiRequest_routeId_createdAt_idx" ON "AiRequest"("routeId", "createdAt");
CREATE INDEX "AiRequest_priceVersionId_idx" ON "AiRequest"("priceVersionId");

CREATE UNIQUE INDEX "AiBillingSettlement_requestId_key" ON "AiBillingSettlement"("requestId");
CREATE INDEX "AiBillingSettlement_canonicalModelId_createdAt_idx" ON "AiBillingSettlement"("canonicalModelId", "createdAt");
CREATE INDEX "AiBillingSettlement_routeId_createdAt_idx" ON "AiBillingSettlement"("routeId", "createdAt");
CREATE INDEX "AiBillingSettlement_priceVersionId_idx" ON "AiBillingSettlement"("priceVersionId");

ALTER TABLE "AiModelRoute" ADD CONSTRAINT "AiModelRoute_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiModelRoute" ADD CONSTRAINT "AiModelRoute_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AiProviderChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiModel" ADD CONSTRAINT "AiModel_defaultRouteId_fkey" FOREIGN KEY ("defaultRouteId") REFERENCES "AiModelRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiModelAlias" ADD CONSTRAINT "AiModelAlias_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPriceVersion" ADD CONSTRAINT "AiPriceVersion_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiModelPricing" ADD CONSTRAINT "AiModelPricing_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiModelPricing" ADD CONSTRAINT "AiModelPricing_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "AiPriceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiUpstreamDiscovery" ADD CONSTRAINT "AiUpstreamDiscovery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AiProviderChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiRouteCostHistory" ADD CONSTRAINT "AiRouteCostHistory_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "AiModelRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "AiModelRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_priceVersionId_fkey" FOREIGN KEY ("priceVersionId") REFERENCES "AiPriceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiBillingSettlement" ADD CONSTRAINT "AiBillingSettlement_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AiRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiBillingSettlement" ADD CONSTRAINT "AiBillingSettlement_canonicalModelId_fkey" FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiBillingSettlement" ADD CONSTRAINT "AiBillingSettlement_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "AiModelRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiBillingSettlement" ADD CONSTRAINT "AiBillingSettlement_priceVersionId_fkey" FOREIGN KEY ("priceVersionId") REFERENCES "AiPriceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
