CREATE TABLE "AiPricingConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "agentRequestCredits" BIGINT NOT NULL,
    "inspirationAnalysisCredits" BIGINT NOT NULL,
    "imageDefaultCredits" BIGINT NOT NULL,
    "videoDefaultCredits" BIGINT NOT NULL,
    "imageModelPrices" JSONB NOT NULL,
    "videoModelPrices" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPricingConfig_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiPricingConfig_nonnegative_credits" CHECK (
        "agentRequestCredits" >= 0
        AND "inspirationAnalysisCredits" >= 0
        AND "imageDefaultCredits" >= 0
        AND "videoDefaultCredits" >= 0
    )
);
