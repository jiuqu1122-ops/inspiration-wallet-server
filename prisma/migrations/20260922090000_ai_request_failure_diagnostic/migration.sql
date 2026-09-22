-- Additive telemetry only: no historical balances, statuses or result payloads are rewritten.
ALTER TABLE "AiRequest" ADD COLUMN "failureDiagnostic" JSONB;
