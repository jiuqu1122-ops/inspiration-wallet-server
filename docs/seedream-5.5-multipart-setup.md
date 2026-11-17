# Seedream 5.5: explicit multipart reference editing

Local implementation only. No provider settings, prices, production services or releases are changed automatically.

## Verified source baseline

- inspiration-wallet-server origin/main: `33c79c752082671008e76174e54d57917f378917`.
- unmind-website origin/main: `c76d2aad4b9c582c301d8968b5330377e61adb8c`.
- The desktop wallet bridge already forwards the published `referenceImageLimit`; its Rust command accepts up to 32 inputs. No desktop code changes are needed for ten supported references.
- Existing uncommitted changes (including previous channel/diagnostics changes) are preserved.

## Root causes

1. An edits endpoint alone did not change the Generic/Seedream JSON request serializer into a file upload.
2. The public image request envelope admitted at most nine images.
3. Generic TASK submission did not accept receipt-free synchronous `data[].url` / `data[].b64_json` for this explicit contract.
4. Task control fields could lose stop-polling intent. A missing interval could also be synthesized into zero; explicit zero must instead pause polling for this contract.
5. Unknown-outcome holds needed protection from the stale-request sweeper as well as protection against immediate POST retries/failover.

## Admin settings: FluxPort / AI Media

Channel:

- API Base URL: `https://api.ai-media.vip`.
- API Key: enter the provider key through the existing secret field; never put it in adapter JSON, source code or documentation.
- Use a channel that already supports the Images API, or the separate OpenAI Compatible channel type once that previous feature is deployed.

Canonical model / capabilities (merge these into that model's existing capabilities; do not copy prices or modify unrelated models):

```json
{
  "supportsReferenceImages": true,
  "supportsImageEdit": true,
  "minReferenceImages": 0,
  "maxReferenceImages": 10,
  "supportedResolutions": ["1k", "1.5k", "2k"],
  "defaultResolution": "1k",
  "supportedAspectRatios": ["21:9", "16:9", "9:21", "2:1", "3:2", "4:3", "5:4", "3:1", "1:1", "4:5", "3:4", "2:3", "9:16", "1:3", "1:2"],
  "supportedQualities": [],
  "outputMode": "single_asset",
  "maxOutputImages": 1,
  "supportsTransparentBackground": false
}
```

Zero references means text-to-image JSON. One to ten means file editing. Do not enable mask; no mask contract is confirmed. Keep existing published billing mode and tariffs unchanged. Any explicit route capability override must also permit ten references; the effective limit is the minimum of the model, route and serializer limits.

Image Route:

- Upstream model: exactly `seedream-5.5`.
- Protocol: **Generic OpenAI Images** (recommended). Explicit file mode also works on **Seedream Images API**.
- Reference format: **file upload image[] (multipart)** (`multipart_image_array`).
- Reference maximum: **10**.
- Prompt character maximum: **8000**.
- Resolution parameter: `resolution`; value mode: `label`.
- Aspect ratio parameter: `aspect_ratio`.
- Generation endpoint: `/v1/images/generations`.
- Edit endpoint: `/v1/images/edits`.
- Async: `true`.
- Enable **Idempotency-Key derived from original request ID**.
- Fixed request parameters (Generic only): `{"n":1,"response_format":"url"}`. Use `b64_json` instead of `url` only if desired. Output count remains exactly one.
- No task operation, Midjourney operation/speed, quality, mask or background parameters are added.
- URL/Data URL transport is irrelevant and disabled in the editor while file mode is selected.

Equivalent adapter JSON (the JSON pane is read-only; use the structured controls):

```json
{
  "referenceSerializer": "multipart_image_array",
  "maxReferenceImages": 10,
  "maxPromptCharacters": 8000,
  "resolutionParameter": "resolution",
  "resolutionValueMode": "label",
  "aspectRatioParameter": "aspect_ratio",
  "generationEndpoint": "/v1/images/generations",
  "editEndpoint": "/v1/images/edits",
  "async": true,
  "idempotencyHeader": "Idempotency-Key",
  "requestParameters": {"n": 1, "response_format": "url"}
}
```

Execution mode: **TASK**. Profile: **GENERIC_TASK**. Configure:

```json
{
  "profile": "GENERIC_TASK",
  "submitEndpoint": "/v1/images/generations",
  "statusEndpointTemplate": "/v1/images/tasks/{taskId}?view=summary",
  "resultEndpointTemplate": "/v1/images/tasks/{taskId}",
  "taskIdPath": "task_id",
  "statusPath": "status",
  "pollAfterMsPath": "poll_after_ms",
  "assetArrayPath": "assets",
  "signedUrlPath": "signed_url",
  "downloadUrlPath": "download_url",
  "urlPath": "url",
  "asyncParameterName": "async",
  "asyncParameterValue": true,
  "submitTimeoutMs": 60000
}
```

Leave status lists at their existing Generic Task defaults. For the selected explicit file contract, real references select the prepared edit endpoint; the no-reference request keeps the generation endpoint.

## Transport and recovery guarantees

- File references are read sequentially with the existing ownership-resolved reader, DNS address pinning, redirect checks, MIME verification and actual decode validation. PNG/JPEG/WebP bytes are staged in bounded temporary files and uploaded through the existing streaming multipart writer.
- Existing limits remain: 10 MiB per reference, 8192x8192 input-pixel bound, 30-second preparation deadline per image, bounded redirects. Large reference sets should use the existing upload-ticket/object-storage flow; the inbound JSON body size is not increased.
- Original order is preserved. Each file field is `image[]`. Runtime-generated boundary and Content-Length match the streamed bytes. No input URL, Data URL text, storage access token or internal authentication header is uploaded as a file.
- Only explicit file routes accept ten. Eleven is rejected before ownership reads, reservation and provider submission. Old JSON routes remain capped by their existing effective limits (including the dedicated Generic Data URL five-image limit).
- Prompt length is checked before reservation. For this explicit contract the user's prompt is submitted unchanged except surrounding whitespace; no hidden natural-language size suffix is added and no silent truncation is used.
- The business idempotency key remains stable for the same user/channel/route/client request; new business requests use new keys.
- Both synchronous images and accepted task receipts are handled. HTTP 200 by itself is never considered a successful generation.
- Accepted tasks, paused polling and uncertain outcomes never trigger another generation POST, protocol switch or route failover. Transient read retries operate only on the original GETs.
- Same-provider protected image downloads use the provider credentials. Third-party images never receive provider credentials. Full URL paths and query strings are retained.
- A synchronous URL is journaled before downloading. If download fails, manual recovery reads that same URL without another generation or reservation.
- A non-billing snapshot marker protects these explicit submissions from the stale-request auto-refund sweeper. Existing legacy clearing rules and all prices remain unchanged. Known explicit terminal failures still release the reservation through the normal path.

## Local verification

New tests:

- `test/seedream-multipart.test.ts`: parses the actual outgoing stream back into multipart fields/files; validates bytes, order, MIME, counts, auth, idempotency, text-to-image JSON, direct URL/Base64, task controls, timeout/abort/5xx, and GET-only download retry.
- `test/seedream-multipart-wallet.test.ts`: real wallet dispatch with local Prisma/storage/network fixtures; HTTP admission of ten/rejection of eleven, pre-reservation validation, original-task recovery, original synchronous URL recovery, concurrent recovery and one settlement only.
- `test/seedream-references.test.ts`: upload ownership, SDK reads, private redirects and file-size limits using the shared reader.
- `test/model-admin-operations.test.ts`: saves/reloads explicit serializer config without changing price or mapping.
- `test/request-recovery.test.ts`: stale unknown multipart submissions remain held.
- Website `tests/admin-ai-model-center.test.mjs`: structured UI selection, validation, serialization and reload.

Run backend `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run lint`, `npm run build` and website `npm test`, `npm run typecheck`, `npm run lint`. Only final executed results should be reported; all provider interactions use fixtures, not a live paid channel.

## Remaining manual checks / limits

- Apply settings deliberately after the reviewed backend and website are deployed; no existing live channel is migrated automatically. This serializer itself needs no database schema migration.
- Verify the actual provider's live response shape, timeout policy, pixel/file limits and idempotency contract with the operator before paid live use. No paid end-to-end request was made.
- When an upstream POST has no recoverable task ID or result URL, the request stays held for manual investigation; this implementation does not invent a receipt or regenerate it.
- No new quality tier, mask editing or transparent-background contract is enabled.
- Desktop/Rhino 1.5K and all-aspect-ratio selector UX are outside this fix. Server serialization accepts `1.5k` as `1.5K`; any existing selector gap requires a separate client task.
- A lower published canonical capability or manual route override intentionally blocks ten even when the serializer allows ten. Update both deliberately, without altering unrelated models.

## Task-scoped changed files

Backend implementation:
- `src/modules/ai/image-adapters/{types,images-api-config,generic-openai-image,seedream,generic-request-headers}.ts`
- `src/modules/ai/{seedream-references,image-service,image-task-retry,model-admin-routes,model-admin,routes,request-recovery}.ts`

Backend tests:
- `test/seedream-multipart.test.ts` (new)
- `test/seedream-multipart-wallet.test.ts` (new)
- `test/seedream-references.test.ts`
- `test/model-admin-operations.test.ts`
- `test/request-recovery.test.ts`

Management website:
- `app/admin/ai-model-center-model.ts`
- `app/admin/ai-model-center.tsx`
- `tests/admin-ai-model-center.test.mjs`

Other dirty files visible in `git status` predate this task and were not included as Seedream changes. No client file was changed in this task.

## Executed final results (2026-11-13, local fixtures only)

- Backend: `npm test -- --maxWorkers=1`: **95 files / 1461 tests passed**, no unhandled errors.
- Backend: `npm run typecheck`, `npm run lint`, `npm run build`: **passed**.
- Website: `npm test` (includes production build): **52 tests passed**.
- Website: `npm run typecheck`: **passed**.
- Website: `npm run lint`: **0 errors, 3 pre-existing img-element warnings**.
- Both repositories: `git diff --check`: **passed**.
- Unrelated pre-existing changes: compared against the initial patch backup and preserved. Client changes were not touched.
- Not executed: live paid image generation, production deployment, SSH, push, desktop packaging, or a new live Rhino/client test. No production channel was edited.
