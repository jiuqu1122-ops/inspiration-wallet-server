-- Backfill exact 2K/4K dimensions for administrator-created GPT Image 2/2.5
-- variants such as "GPT Image 2.5 high", while preserving every other
-- capability configured in the model center.
WITH image2_dimensions AS (
  SELECT '{
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
)
UPDATE "AiModel"
SET
  "capabilities" = jsonb_set(
    jsonb_set(
      COALESCE("capabilities", '{}'::jsonb),
      '{aspectRatiosByResolution}',
      image2_dimensions.value,
      true
    ),
    '{supportedAspectRatiosByResolution}',
    image2_dimensions.value,
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM image2_dimensions
WHERE "modality" = 'image'
  AND (
    regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
    OR regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') IN ('image2', 'gptimagemedium')
    OR regexp_replace(lower("canonicalModelKey"), '[^a-z0-9]+', '', 'g') ~ '^image2([0-9]|h|medium)'
    OR regexp_replace(lower("displayName"), '[^a-z0-9]+', '', 'g') LIKE '%gptimage2%'
  );
