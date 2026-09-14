-- Internal usage bindings point to canonical Chat models, never upstream ids.
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'USAGE_MODEL_BINDING_UPDATED';

CREATE TABLE "AiUsageModelBinding" (
    "key" TEXT NOT NULL,
    "canonicalModelId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiUsageModelBinding_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "AiUsageModelBinding_canonicalModelId_idx"
ON "AiUsageModelBinding"("canonicalModelId");

ALTER TABLE "AiUsageModelBinding"
ADD CONSTRAINT "AiUsageModelBinding_canonicalModelId_fkey"
FOREIGN KEY ("canonicalModelId") REFERENCES "AiModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- The initial selection is deterministic configuration bootstrap, not a
-- request-time fallback. Administrators can change either binding afterwards.
INSERT INTO "AiUsageModelBinding" ("key", "canonicalModelId", "updatedAt")
SELECT usage."key", selected."id", CURRENT_TIMESTAMP
FROM (VALUES ('CANVAS_TEXT'), ('IMAGE_ANALYSIS')) AS usage("key")
CROSS JOIN LATERAL (
  SELECT model."id"
  FROM "AiModel" model
  WHERE model."modality" = 'chat'
    AND model."enabled" = TRUE
    AND model."status" = 'PUBLISHED'
    AND EXISTS (
      SELECT 1
      FROM "AiModelRoute" route
      JOIN "AiProviderChannel" channel ON channel."id" = route."channelId"
      WHERE route."canonicalModelId" = model."id"
        AND route."enabled" = TRUE
        AND route."upstreamAvailable" = TRUE
        AND upper(route."healthStatus") NOT IN ('UNAVAILABLE', 'UNHEALTHY', 'DOWN', 'FAILED', 'DISABLED')
        AND channel."status" = 'ACTIVE'
        AND (
          usage."key" <> 'IMAGE_ANALYSIS'
          OR model."capabilities"->>'supportsVision' = 'true'
          OR route."capabilitiesOverride"->>'supportsVision' = 'true'
          OR to_jsonb(channel."capabilities") ? 'VISION'
        )
    )
  ORDER BY
    CASE model."canonicalModelKey"
      WHEN 'gpt-5.6-sol' THEN 0
      WHEN 'gpt-6-astra' THEN 1
      ELSE 2
    END,
    model."sortOrder",
    model."canonicalModelKey"
  LIMIT 1
) selected
ON CONFLICT ("key") DO NOTHING;

-- Normalize only GPT Image 2/2.5 capability fields involved in this repair.
-- Unrelated administrator-managed capability fields remain untouched.
WITH image2_dimensions AS (
  SELECT '{
    "1k": [
      "1024x1024", "1280x720", "720x1280", "1152x768",
      "768x1152", "1024x768", "768x1024"
    ],
    "2k": [
      "2048x2048", "2048x1152", "1152x2048", "2064x1376",
      "1376x2064", "2048x1536", "1536x2048", "2016x864",
      "864x2016", "2080x1664", "1664x2080", "2048x1024",
      "2064x688"
    ],
    "4k": [
      "2880x2880", "3840x2160", "2160x3840", "3520x2352",
      "2352x3520", "3312x2480", "2480x3312", "3840x1648",
      "1648x3840", "3216x2576", "2576x3216", "3840x1920",
      "3840x1280", "1280x3840"
    ]
  }'::jsonb AS value
), image2_models AS (
  SELECT "id"
  FROM "AiModel"
  WHERE "modality" = 'image'
    AND (
      regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
      OR regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') IN ('image2', 'gptimagemedium')
      OR regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') ~ '^image2([0-9]|h|medium)'
      OR regexp_replace(lower("displayName"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
    )
)
UPDATE "AiModel" model
SET "capabilities" = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(model."capabilities", '{}'::jsonb),
          '{supportedResolutions}', '["1k", "2k", "4k"]'::jsonb, true
        ),
        '{aspectRatiosByResolution}', image2_dimensions.value, true
      ),
      '{supportedAspectRatiosByResolution}', image2_dimensions.value, true
    ),
    "updatedAt" = CURRENT_TIMESTAMP
FROM image2_dimensions, image2_models
WHERE model."id" = image2_models."id";

-- Discovery snapshots must not accidentally narrow canonical runtime support.
-- Explicit MANUAL overrides are preserved.
UPDATE "AiModelRoute" route
SET "capabilitiesOverride" = route."capabilitiesOverride"
      - 'resolutions'
      - 'supportedResolutions'
      - 'aspectRatiosByResolution'
      - 'supportedAspectRatiosByResolution',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE route."canonicalModelId" IN (
  SELECT "id" FROM "AiModel"
  WHERE "modality" = 'image'
    AND (
      regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
      OR regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') IN ('image2', 'gptimagemedium')
      OR regexp_replace(lower("displayName"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
    )
)
AND COALESCE(route."metadata"->>'capabilitiesOverrideSource', '') <> 'MANUAL'
AND route."capabilitiesOverride" IS NOT NULL;
