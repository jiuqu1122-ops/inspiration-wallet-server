-- AddTable
CREATE TABLE "AiVideoTask" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "routeId" TEXT,
    "outputIndex" INTEGER NOT NULL,
    "upstreamTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "assetState" TEXT,
    "videoAvailable" BOOLEAN,
    "pollAfterMs" INTEGER,
    "lastPolledAt" TIMESTAMP(3),
    "resultObjectKey" TEXT,
    "resultUrl" TEXT,
    "upstreamPayload" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiVideoTask_pkey" PRIMARY KEY ("id")
);

-- AddIndex
CREATE UNIQUE INDEX "AiVideoTask_requestId_outputIndex_key" ON "AiVideoTask"("requestId", "outputIndex");
CREATE UNIQUE INDEX "AiVideoTask_routeId_upstreamTaskId_key" ON "AiVideoTask"("routeId", "upstreamTaskId");
CREATE INDEX "AiVideoTask_requestId_status_idx" ON "AiVideoTask"("requestId", "status");
CREATE INDEX "AiVideoTask_routeId_status_idx" ON "AiVideoTask"("routeId", "status");
CREATE INDEX "AiVideoTask_status_lastPolledAt_idx" ON "AiVideoTask"("status", "lastPolledAt");

-- AddForeignKey
ALTER TABLE "AiVideoTask" ADD CONSTRAINT "AiVideoTask_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AiRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiVideoTask" ADD CONSTRAINT "AiVideoTask_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "AiModelRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;
