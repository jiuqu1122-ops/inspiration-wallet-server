CREATE TYPE "AiRouteExecutionMode" AS ENUM ('INHERIT', 'DIRECT', 'TASK');

ALTER TABLE "AiModelRoute"
ADD COLUMN "executionMode" "AiRouteExecutionMode" NOT NULL DEFAULT 'INHERIT',
ADD COLUMN "executionConfig" JSONB;
