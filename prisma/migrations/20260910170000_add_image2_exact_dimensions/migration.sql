-- Preserve all administrator-managed model fields while publishing the exact
-- GPT Image 2/2.5 dimensions that differ between the 2K and 4K tiers.
UPDATE "AiModel"
SET
  "capabilities" = jsonb_set(
    COALESCE("capabilities", '{}'::jsonb),
    '{supportedAspectRatiosByResolution}',
    '{
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
    }'::jsonb,
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "canonicalModelKey" IN ('image2', 'gpt-image-medium');
