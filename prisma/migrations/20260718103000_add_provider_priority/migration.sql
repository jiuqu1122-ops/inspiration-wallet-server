-- Lower values are selected first by the AI router.
ALTER TABLE "AiProviderChannel"
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;

CREATE INDEX "AiProviderChannel_status_priority_idx"
ON "AiProviderChannel"("status", "priority");
