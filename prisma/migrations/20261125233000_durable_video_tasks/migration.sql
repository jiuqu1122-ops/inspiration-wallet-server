ALTER TABLE "AiRequest" ADD COLUMN "videoDispatch" TEXT;
ALTER TABLE "AiVideoTask"
    ADD COLUMN "nextPollAt" TIMESTAMP(3),
    ADD COLUMN "leaseUntil" TIMESTAMP(3),
    ADD COLUMN "leaseToken" TEXT,
    ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "deliverySource" TEXT,
    ADD COLUMN "failureDiagnostic" JSONB;
CREATE INDEX "AiVideoTask_status_nextPollAt_leaseUntil_idx"
    ON "AiVideoTask"("status", "nextPollAt", "leaseUntil");

-- Existing managed receipts can be polled again. A reservation without a
-- receipt may have been sent by the old API, so it must never be resubmitted.
UPDATE "AiVideoTask" t SET
    "status" = CASE WHEN t."upstreamTaskId" IS NULL THEN 'SUBMISSION_PENDING' ELSE 'PROCESSING' END,
    "nextPollAt" = CASE WHEN t."upstreamTaskId" IS NOT NULL
        THEN COALESCE(t."lastPolledAt" + COALESCE(t."pollAfterMs", 0) * INTERVAL '1 millisecond',
                      CURRENT_TIMESTAMP AT TIME ZONE 'UTC') END
FROM "AiRequest" r
WHERE r.id = t."requestId" AND r.status IN ('RESERVED', 'PROCESSING')
  AND t.status NOT IN ('SUCCEEDED', 'FAILED');

-- Adopt receipts from the legacy journal, including old already-charged
-- requests whose mirror never finished. The worker pins the journal channel.
WITH legacy AS (
    SELECT r.id, r.result, r."createdAt", r."clientRequestId",
        CASE WHEN jsonb_typeof(r.result->'upstreamTaskIds') = 'array'
             THEN r.result->'upstreamTaskIds' ELSE '[]'::jsonb END AS receipts
    FROM "AiRequest" r
    WHERE r.capability = 'VIDEO'
      AND (r.status IN ('RESERVED', 'PROCESSING')
        OR (r.status = 'SUCCEEDED' AND (r.result->>'providerChannelId' IS NOT NULL OR r."routeId" IS NOT NULL)
            AND r.result::text NOT LIKE '%/v1/ai/video-results/%'))
      AND NOT EXISTS (SELECT 1 FROM "AiVideoTask" t WHERE t."requestId" = r.id)
), receipts AS (
    SELECT l.id, l.result, l."createdAt", t.upstream_id,
           row_number() OVER (PARTITION BY l.id ORDER BY t.ordinality) - 1 AS output_index
    FROM legacy l CROSS JOIN LATERAL (
        SELECT upstream_id, min(ordinality) AS ordinality FROM (
            SELECT value #>> '{}' AS upstream_id, ordinality
            FROM jsonb_array_elements(l.receipts) WITH ORDINALITY x(value, ordinality)
            WHERE jsonb_typeof(value) = 'string'
            UNION ALL
            SELECT COALESCE(entry->>'upstreamTaskId', entry->>'task_id', entry->>'taskId'), ordinality
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.result->'results') = 'array'
                 THEN l.result->'results' ELSE '[]'::jsonb END) WITH ORDINALITY x(entry, ordinality)
            WHERE jsonb_array_length(l.receipts) = 0
            UNION ALL
            SELECT COALESCE(l.result->>'upstreamTaskId', l.result->>'task_id', l.result->>'taskId'), 1::bigint
            WHERE jsonb_array_length(l.receipts) = 0 AND jsonb_typeof(l.result->'results') IS DISTINCT FROM 'array'
        ) candidates
        WHERE length(upstream_id) BETWEEN 1 AND 256 AND upstream_id <> l."clientRequestId"
        GROUP BY upstream_id
    ) t
)
INSERT INTO "AiVideoTask" (
    id, "requestId", "outputIndex", "upstreamTaskId", status, "resultUrl", "nextPollAt", "createdAt", "updatedAt", "completedAt"
)
SELECT 'video-legacy-' || r.id || '-' || r.output_index, r.id, r.output_index::integer, r.upstream_id,
       CASE WHEN saved.url IS NULL THEN 'PROCESSING' ELSE 'SUCCEEDED' END, saved.url,
       CASE WHEN saved.url IS NULL THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' END, r."createdAt",
       CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CASE WHEN saved.url IS NOT NULL THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' END
FROM receipts r
LEFT JOIN LATERAL (
    SELECT COALESCE(item->>'video_url', item->>'resultUrl', item->>'result_url') AS url
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.result->'results') = 'array'
         THEN r.result->'results' ELSE '[]'::jsonb END) item
    WHERE COALESCE(item->>'task_id', item->>'taskId') = r.upstream_id
      AND COALESCE(item->>'video_url', item->>'resultUrl', item->>'result_url')
          ~ '^https?://[^/?#@]+/v1/ai/video-results/[a-f0-9]{64}\.(mp4|webm|mov|m4v|avi)$'
    LIMIT 1
) saved ON true;

INSERT INTO "AiVideoTask" (id, "requestId", "outputIndex", status, "createdAt", "updatedAt")
SELECT 'video-legacy-' || r.id || '-0', r.id, 0, 'SUBMISSION_PENDING', r."createdAt",
       CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
FROM "AiRequest" r
WHERE r.capability = 'VIDEO' AND r.status IN ('RESERVED', 'PROCESSING')
  AND NOT EXISTS (SELECT 1 FROM "AiVideoTask" t WHERE t."requestId" = r.id);

-- API responses and signed output URLs are no longer needed in task history.
UPDATE "AiVideoTask" SET "upstreamPayload" = NULL, "lastError" = NULL
WHERE "upstreamPayload" IS NOT NULL OR "lastError" IS NOT NULL;

-- Keep historical result and receipt fields in their existing layout, while
-- removing old provider bodies and free-form errors from video journals.
UPDATE "AiRequest" r SET result =
    (r.result - ARRAY['upstream', 'upstreamPayload', 'lastError', 'error'])
    || CASE WHEN jsonb_typeof(r.result->'results') = 'array' THEN jsonb_build_object('results', COALESCE(
        (SELECT jsonb_agg(CASE WHEN jsonb_typeof(item) = 'object'
                    THEN item - ARRAY['upstream', 'upstreamPayload', 'lastError', 'error'] ELSE item END ORDER BY n)
         FROM jsonb_array_elements(r.result->'results') WITH ORDINALITY rows(item, n)), '[]'::jsonb))
       ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(r.result->'tasks') = 'array' THEN jsonb_build_object('tasks', COALESCE(
        (SELECT jsonb_agg(CASE WHEN jsonb_typeof(item) = 'object'
                    THEN item - ARRAY['upstream', 'upstreamPayload', 'lastError', 'error'] ELSE item END ORDER BY n)
         FROM jsonb_array_elements(r.result->'tasks') WITH ORDINALITY rows(item, n)), '[]'::jsonb))
       ELSE '{}'::jsonb END
WHERE r.capability = 'VIDEO' AND jsonb_typeof(r.result) = 'object'
  AND r.result::text ~ '"(upstream|upstreamPayload|lastError|error)"[[:space:]]*:';
