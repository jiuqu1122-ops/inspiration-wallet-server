# Generic Images API route parameters

`GENERIC_OPENAI_IMAGE` routes can explicitly set `adapterConfig.requestParameters`
to add fixed, flat JSON fields to their submitted body. Unconfigured routes and
other adapters retain their existing payloads. No model name or provider host is
used to activate this behavior.

The object accepts at most 20 fields, with string (up to 1000 characters), finite
number, or boolean values. Model identity, prompt, image inputs, masks, resolution,
aspect ratio, quality, output format, background, streaming, and async fields are
protected; configure those through their existing controls. Nested objects,
arrays, null values, prototype keys, and invalid field names are rejected.
An empty object removes the optional setting. A fixed `n` must match the actual
request count, and must not conflict with the reference-only count. Likewise,
fixed and reference-only `response_format` settings must agree.

`idempotencyHeader: "Idempotency-Key"` is an independent Generic route opt-in.
It derives a submission key from the authenticated user, provider, route, and
logical client request ID. A new generation needs a new request ID; retrying the
same logical request retains the key even if a signed reference URL changes.
It does not enable automatic POST retries. Existing gateway-specific receipt
handling (including the confirmed USELG V8.2 Imagine contract below) retains priority. Polling and downloads do not use this generated header.

## Example: Midjourney V8.2 Imagine

Create a separate managed image model and map its route to the exact upstream
ID `midjourney-v8.2`. Keep the working V7 route unchanged. The upstream contract
provided on 2026-10-15 uses the same generations endpoint for text and references.

Set the route protocol to Generic OpenAI Images and configure:

```json
{
  "generationEndpoint": "/v1/images/generations",
  "editEndpoint": "/v1/images/generations",
  "resolutionParameter": "none",
  "aspectRatioParameter": "aspect_ratio",
  "referenceSerializer": "object_image_url",
  "referenceTransport": "data_url",
  "requestParameters": {
    "operation": "imagine",
    "speed": "fast",
    "n": 1
  },
  "idempotencyHeader": "Idempotency-Key",
  "preserveTaskMetadata": true
}
```

Set execution mode to TASK, profile to Generic Task, submit endpoint to
`/v1/images/generations`, and status template to
`/v1/images/tasks/{taskId}?view=summary`. The upstream always creates asynchronous
tasks; leave the optional async parameter unset unless the upstream confirms it
is required. Use `task_id`, `status`, `poll_after_ms`, and `assets` for their
corresponding paths, and `download_url` / `url` for asset URLs. Processing statuses
are `queued`, `dispatching`, and `running`; completed status is `success`; stopped
statuses are `failed`, `canceled`, and `client_disconnected`. Preserve paused and
uncertain tasks for inspection instead of creating another generation.

Enable reference images and native image editing, set the reference range to
0–5, and maximum request outputs to 1. The edit endpoint above deliberately
equals the generation endpoint. Disable quality and transparent-background
capabilities; no size/resolution, quality, output_format, background, mask, or
stream fields are needed for this contract. Format selection in the client does
not add `output_format` to this Generic request.

Use per-request billing. A four-panel image is one asset; only use the multiple
asset result mode when the upstream actually returns separate assets. A task
with several returned assets is still one successful request and retains the
existing result persistence and settlement path.

Reference data preparation retains the existing authorized-cache/COS, public-URL,
SSRF, redirect, MIME, and 20 MiB per-image checks. Private asset URLs are resolved
to bytes rather than sent as URLs. Verification tests use mocked upstream
responses; production acceptance still requires a configured channel and a real
generation.

### Confirmed USELG V8.2 Imagine compatibility

For the exact HTTPS host `api.uselg.top`, upstream model `midjourney-v8.2`,
Generic adapter and fixed `operation: "imagine"`, text and reference requests
preserve the user's prompt rather than appending generic resolution or background
instructions after native Midjourney parameters. The server always derives the
same owner/provider/route/logical-request Idempotency-Key used by the explicit
Generic opt-in. It does not depend on the channel's USELG versus NEW_API kind,
and changing signed reference URLs does not create a new logical receipt.
Keeping the explicit header option enabled is still recommended for clarity.

Before any generation POST, this confirmed contract rejects the edits endpoint,
unsupported JSON fields (including size, quality, background, output_format,
stream and async), a non-fast speed, n other than 1, and references not serialized
as 1-5 complete PNG/JPEG/WebP Data URLs in `images[].image_url`. Text-only requests
omit `images`. Existing reference-byte validation and per-image 20 MiB limits
remain unchanged. Other hosts, model IDs, operations, V7 routes and Generic
request-parameter opt-ins retain their previous behavior.

Mocked HTTP and wallet tests cover text, one reference, five references, internal
model-alias mapping, queued/dispatching/running/success polling, authenticated
relative asset downloads, single settlement, and no generation resubmission after
failure. Recognized quota and content-policy codes produce fixed safe failure
summaries; raw upstream error text, URLs, prompts and credentials are not exposed.
These tests are not a production generation or proof of upstream availability.

## Reserving task information for future operation controls

Generic routes using TASK execution with the `GENERIC_TASK` profile can opt in
to `preserveTaskMetadata: true`. Only bounded,
recognized task and button fields are retained in `taskMetadata`; raw upstream
JSON, asset URLs, credentials, and internal polling addresses are not exposed.
The original request remains owned by the authenticated user, and successful
queries, same-request replay, and GET-only result recovery preserve this metadata.
The field is additive, so existing clients can continue using the image results.

The optional `enableTaskOperations: true` setting enables the authenticated
operation API described in [image-task-operations.md](image-task-operations.md).
It requires metadata preservation, the idempotency header, fixed `imagine`, a
confirmed speed, `n: 1`, and Generic TASK execution. Published operation prices
are also required. Follow-up submissions resolve an owned parent, keep its
original route, account, model and speed, and validate its actual returned action.
An action descriptor alone is not permission to submit or charge. Modal windows
require a separate explicit confirmation; polling never confirms or generates.
