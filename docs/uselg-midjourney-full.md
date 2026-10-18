# USELG Midjourney V8.2-full: text and reference generation

This is the supplied `midjourney-v8.2-full` Images API contract. It is not the
ordinary `midjourney-v8.2` operation API. Keep a separate managed model and route;
do not overwrite a working V7 or ordinary V8.2 route.

## Model and route

- API origin: `https://api.uselg.top`; confirm the group's access to the exact
  upstream model `midjourney-v8.2-full` with `GET /v1/models`.
- Protocol: Generic OpenAI Images. Execution: TASK, Generic Task.
- Submit and generation endpoints: `/v1/images/generations`.
- Edit endpoint: `/v1/images/edits`. Enable reference-image and native-image-edit
  capabilities so actual references select this endpoint. No mask support.
- Async parameter name: `async`; value: `true`.
- Status template: `/v1/images/tasks/{taskId}?view=summary`.
- Task paths: `task_id`, `status`, `poll_after_ms`, `assets`; asset URL paths:
  `signed_url`, `download_url`, `url`.
- Processing statuses: `queued, dispatching, running`; completed: `success`;
  stopped: `failed, canceled, client_disconnected`. Preserve paused/uncertain
  tasks for inspection; never create another generation automatically.

Adapter configuration example (the advanced JSON in AI Center is read-only;
apply each field using the corresponding form controls):

```json
{
  "generationEndpoint": "/v1/images/generations",
  "editEndpoint": "/v1/images/edits",
  "resolutionParameter": "size",
  "resolutionValueMode": "exact",
  "aspectRatioParameter": "none",
  "exactDimensions": {
    "1K": {
      "1:1": "1024x1024",
      "16:9": "1600x900",
      "9:16": "900x1600",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
      "4:3": "1024x768",
      "3:4": "768x1024"
    }
  },
  "referenceSerializer": "object_image_url",
  "referenceTransport": "data_url",
  "referenceRequestCount": 1,
  "requestParameters": { "n": 1, "response_format": "b64_json" },
  "idempotencyHeader": "Idempotency-Key"
}
```

The 1K label is a client compatibility placeholder, not an upstream resolution
quality tier. `size` expresses only the aspect ratio, not guaranteed output
pixels. Only advertise ratios with a configured mapping. The backend also
accepts the documented 5:4, 4:5 and 21:9 ratios when explicitly mapped; the current
AI Center exact-dimension form exposes the seven ratios shown above.

## Output and billing capabilities

- Output mode: multiple assets; maximum output images: 4.
- Maximum request output count: 1 (`n=1` is one group, not one returned asset).
- Bill once per successful request, not once per returned image. Set the local
  credit price deliberately; upstream balance-unit quotes are not wallet credits.
- Reference range: 0-5. Prepared references must be full PNG/JPEG Data URLs,
  at most 20 MiB each; the existing WebP reader converts to PNG before submission.
- Disable quality and transparent-background capabilities. Do not send mask,
  background, output_format, output_compression or stream.
- Remove old fixed `operation` and `speed` fields. Leave follow-up task
  operations disabled; this Images API has no U/V or modal operation contract.

## Compatibility and verification

The exact origin/model/Generic route preserves trimmed user text without the
ordinary resolution/background suffix. It counts Unicode code points and limits
text to 1002 characters when the upstream must add ` --v 8.2`, or 1010 characters
including a single explicit, matching version flag. It never truncates prompts.
A numeric `mj_version`, another version, Niji or duplicate version flags are
rejected before submission. Omitting the optional version field is recommended.

The confirmed route always uses the existing owner/provider/route/logical-request
idempotency scope, independently of USELG versus NEW_API channel kind. It does
not retry generation POSTs. HTTP 202 tasks retain existing receipt ownership,
read-only recovery, Retry-After, authenticated asset download and settlement.
HTTP 200 final `data[]` URL/base64 results use the strict final-image validator;
invalid or unfinished results are not fabricated into success. Both paths retain
all returned images up to the configured result limit and settle once.

These changes do not select or reconfigure a production route. Configure and
save the new full route after deployment. Automated tests use mocked upstream
responses; no paid generation or production acceptance is implied.
