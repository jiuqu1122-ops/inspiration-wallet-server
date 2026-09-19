UPDATE "AiModel"
SET "capabilities" = jsonb_set(
  "capabilities"::jsonb,
  '{defaultResolution}',
  '"768p"'::jsonb,
  true
),
"updatedAt" = CURRENT_TIMESTAMP
WHERE "canonicalModelKey" = 'minimax-h3'
  AND "modality" = 'video'
  AND jsonb_typeof("capabilities"::jsonb) = 'object'
  AND NOT ("capabilities"::jsonb ? 'defaultResolution')
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE("capabilities"::jsonb -> 'supportedResolutions', '[]'::jsonb)
    ) AS resolution(value)
    WHERE lower(resolution.value) = '768p'
  );
