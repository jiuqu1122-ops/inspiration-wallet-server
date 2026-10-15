# Image task operations API

This API implements the documented Midjourney-style operation contract without
hardcoding a model name or provider hostname. Existing image generation routes
and clients are unchanged unless a route explicitly opts in. No client update is
required for ordinary Imagine generation; operation controls can be added later.

## Management configuration

Use a separate managed image model with its actual upstream ID. On its Generic
OpenAI Images route, use TASK / GENERIC_TASK and the documented generations
submission endpoint. Both generation and edit endpoints are
`/v1/images/generations`. Keep resolution serialization disabled, map the ratio
to `aspect_ratio`, and use `object_image_url` plus `data_url` for references.

Configure these route options:

```json
{
  "requestParameters": {"operation":"imagine","speed":"fast","n":1},
  "idempotencyHeader": "Idempotency-Key",
  "preserveTaskMetadata": true,
  "enableTaskOperations": true
}
```

Enable only confirmed reference and ratio capabilities. The Images operations
contract uses one task per request, up to five PNG/JPEG/WebP references, and no
quality, background, output format, or mask field on Imagine. The existing safe
reference preparation preserves supported PNG/JPEG and converts WebP to PNG,
with a 20 MiB decoded-image limit and authorized local/COS reads, public DNS,
redirect restrictions and size checks. Internal authenticated image URLs are
never sent as upstream references. The operation route accepts at most 150 MiB
of JSON; uploaded reference tickets are preferable to large inline requests.

Use image_flat pricing and publish a `creditsPerOperation` matrix. Management has
structured inputs for each operation and speed. Blank means unavailable; an
explicit `"0"` means free. These illustrative credit amounts are not channel costs:

```json
{
  "billingType": "image_flat",
  "creditsPerRequest": "30",
  "creditsPerOperation": {
    "imagine": {"fast":"30"},
    "upscale": {"fast":"20"},
    "inpaint": {"fast":"30"},
    "custom_zoom": {"fast":"30"},
    "modal": {"fast":"12"}
  }
}
```

Each new operation locks its published price, including valid membership price
overrides/discounts. Its result count never multiplies that price. Image-count
membership quota is not consumed by this dedicated paid-operation API. Ordinary
Imagine generation retains the existing generation quota policy. Queries and
downloads do not reserve credits or create another operation. Result-unknown
operations retain their reservation; only definite rejection or terminal failure
releases it. Generic stale-image cleanup skips captured operation tariffs.

## Authenticated endpoints

All endpoints use the existing wallet access token. Owner identity comes from
the token, never from request JSON. Request IDs must be 8–128 characters.

- `POST /v1/ai/images/operations`: submit one explicit operation, returning 202
  while pending and 200 for a terminal result.
- `GET /v1/ai/images/operations/by-request/{clientRequestId}`: read and refresh the
  original receipt, respecting a minimum five-second read interval and upstream
  polling hints. It never submits a new generation.
- `POST /v1/ai/images/operations/by-request/{clientRequestId}/refresh`: the same
  read-side refresh, with an empty body only.

Initial Imagine request:

```json
{"clientRequestId":"mj-imagine-new-001","model":"your-canonical-model","operation":"imagine","prompt":"a quiet mountain village","aspectRatio":"16:9"}
```

`speed` can be specified for an initial operation or taken from its explicitly
configured route. Reference Imagine uses `inputImages` with owned upload URLs or
full Data URLs. Blend requires 2–5 inputs and optional `dimensions` (`SQUARE`,
`PORTRAIT`, `LANDSCAPE`); Describe requires one; Uploads accepts 1–5. Shorten takes
a prompt and no image. Reference capability switches and limits apply before any
reference fetch or credit reservation.

Action request:

```json
{"clientRequestId":"mj-upscale-new-002","model":"your-canonical-model","operation":"upscale","parentClientRequestId":"mj-imagine-new-001","actionId":"copy-the-exact-returned-actionId"}
```

Use the app's original `clientRequestId` as the parent identifier. The server
resolves the platform task ID and the stored action, and rejects foreign users,
another model, expired parents, changed accounts/routes, mismatched action IDs,
or a speed change. The parent must have completed with a verified private
operation context. Pre-update historical tasks lacking that context are rejected
instead of guessed. Parent tasks are never rediscovered from filenames or image
URLs. The same request ID and same parameters replay the original operation;
changed parameters return 409, and even failed request IDs are not recycled.

Supported protocol operation names are `imagine`, `blend`, `describe`, `shorten`,
`uploads`, `upscale`, `upscale_creative`, `upscale_subtle`, `upscale_subtile`,
`variation`, `high_variation`, `low_variation`, `reroll`, `zoom`, `custom_zoom`,
`pan`, `inpaint`, and `modal`. The two subtle/subtile names stay distinct. Speeds
are configurable as fast/relax/turbo, but only publish a pair confirmed by the
channel. Pricing does not prove upstream availability; the supplied channel
document only confirms Imagine, Blend and Describe in its tested fast group.

## Modal confirmation

Submit the actual Inpaint or Custom Zoom action first. Its new task must return
`requiresModal: true` and an actual `modal` action. The server bills that first
step once but does not confirm it automatically.

```json
{"clientRequestId":"mj-modal-new-004","model":"your-canonical-model","operation":"modal","parentClientRequestId":"mj-inpaint-new-003","actionId":"the-new-window-modal-actionId","prompt":"replace the selected area with a flowering tree","maskBase64":"data:image/png;base64,..."}
```

For inpainting, the mask must be a complete PNG, fully opaque and grayscale,
with at least one white edit pixel. Its dimensions must match the actual original
result image; reference dimensions or an empty window task are not substitutes.
Ambiguous/missing original image dimensions are rejected. Black preserves and
white edits. A Custom Zoom modal uses a prompt and `zoom` from 1 to 2 instead,
with no mask. The second step uses a new request ID and is charged independently.

## Results, recovery and accounting

Results contain `clientRequestId`, `status`, `operation`, `speed`, optional `taskId`,
`images`, `texts`, `uploadedUrls`, `requiresModal`, safe `taskMetadata`,
`chargedCredits`, and polling hints. Images are locally persisted/mirrored before
completion. Describe/Shorten complete with text, Uploads with public HTTPS URLs,
window operations with a modal descriptor, and image operations with images.
Wrong result types remain unconfirmed rather than being charged as success.
Private status addresses, account fingerprints, receipt hashes, and raw upstream
responses are not returned to clients.

Every explicit submission makes at most one generation POST, to its selected
route. There is no automatic channel failover, alternate serialization POST,
or task resubmission after timeout/5xx/uncertainty. If the submission response was
lost, refresh may look up the original hashed client receipt on the same account
and then query its actual task ID. It never manufactures another task. Paused and
uncertain states retain the original request and credits for further inspection.
Concurrent refreshes cannot replace an accepted task ID with a stale no-ID
snapshot; settlement/refund use transactional identity checks and claim the
wallet reservation only once.

Tests use mocked DNS, HTTP, local image I/O and transactional fixtures. A live
channel smoke test is still needed after deployment; no paid channel call is
made as part of local validation.
