ALTER TABLE "AiPricingConfig"
ADD COLUMN "canvasTextAgentCredits" BIGINT NOT NULL DEFAULT 1;

ALTER TABLE "AiPricingConfig"
ADD CONSTRAINT "AiPricingConfig_canvas_text_agent_nonnegative"
CHECK ("canvasTextAgentCredits" >= 0);
