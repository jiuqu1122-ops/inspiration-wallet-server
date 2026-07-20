CREATE TYPE "AiTaskType" AS ENUM ('AGENT_CHAT', 'INSPIRATION_ANALYSIS');

CREATE TYPE "AiTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AiTaskType" NOT NULL,
    "status" "AiTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "requestId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiTask_userId_type_requestId_key" ON "AiTask"("userId", "type", "requestId");
CREATE INDEX "AiTask_status_createdAt_idx" ON "AiTask"("status", "createdAt");
CREATE INDEX "AiTask_status_heartbeatAt_idx" ON "AiTask"("status", "heartbeatAt");
CREATE INDEX "AiTask_userId_updatedAt_idx" ON "AiTask"("userId", "updatedAt");

ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
