CREATE TABLE "ChatPricingConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "modelPrices" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPricingConfig_pkey" PRIMARY KEY ("id")
);
