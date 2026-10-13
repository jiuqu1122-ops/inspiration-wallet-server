# Seedream Images API reference preparation

The published `api.ai-media.vip` integration description confirms `/v1/images/generations`, `/v1/images/edits` when enabled for the selected group, and publicly accessible image URLs. It does not publish a dedicated edit payload example or confirm Data URL support. The server therefore retains the route's explicitly configured serializer and defaults Seedream reference transport to `public_https`. It never switches format or resubmits a task after an upstream failure.

The existing `SEEDREAM_IMAGES_API` adapter remains the dedicated adapter. Existing `GENERIC_OPENAI_IMAGE` routes whose submitted model is Seedream also use this preparation path, without changing their route, adapter key, or model mapping. Other model families retain their existing behavior.

## Route settings

`adapterConfig.referenceTransport`:

- `public_https` (default): validate the image, copy its bytes to the shared temporary store, and anonymously fetch the generated URL to verify its public HTTPS route before submitting the edit.
- `data_url`: validate the image and submit `data:<detected MIME>;base64,...`. Enable only after the channel confirms this capability.

`adapterConfig.referenceSerializer` remains mandatory for edits:

| Value | Request shape |
| --- | --- |
| `json_image` | `{"image":"..."}` (one reference only) |
| `json_images` | `{"images":["..."]}` |
| `object_image_url` | `{"images":[{"image_url":"..."}]}` |

Choose the serializer using the selected channel/group's confirmed edit contract. Transport and serializer are independent. No mask or multipart capability is inferred from a generic Images API description.

## Source and conversion flow

1. A client local file is uploaded using the existing upload ticket. Its reference object key is authorized by `resolveReferenceImageSources`; the server never reads a user's filesystem path.
2. Configured COS/OSS objects are read using the trusted Storage SDK. Public or signed third-party HTTPS URLs are downloaded without provider Authorization, cookies, or login.
3. Arbitrary URL downloads require HTTPS, no URL credentials, public DNS answers only, and no loopback, RFC1918, link-local, cloud metadata, or non-global IPv6 addresses. Validated DNS addresses are pinned to the download connection. Every redirect repeats these checks, with a maximum of three redirects. A download has a 30-second preparation budget.
4. All sources, including inline Data URLs and cached references, require valid base64 where applicable, at most 10 MiB, matching MIME/actual format, and a successful image decode. Supported formats are PNG, JPEG, WebP and GIF. Decoding is limited to 8192 × 8192 pixels and 10 seconds. Reference dimensions are not changed.
5. For `public_https`, a random 256-bit key identifies a file in `IMAGE_RESULT_STORE_DIR/provider-references`, shared by API and worker. `/v1/ai/provider-references/:key` serves it without authentication or redirects, with `Cache-Control: no-store`. Access expires after 30 minutes. The store prunes expired files during writes and refuses new references at its 256 MiB budget instead of evicting references of accepted tasks. Failed public-route verification removes the temporary file.
6. The prepared references are reused between route preflight and dispatch, including tablet batch splitting. Seedream edits keep the prepared edit endpoint in TASK mode, including existing Generic adapter routes whose task configuration names the generation endpoint. Model identity, size/exact, TASK text-to-image generation, billing, and automatic resend protection retain their existing contracts.

Diagnostics `image_adapter_reference_prepared` and `image_adapter_reference_preparation_failed` include source type and safe metadata only. They do not contain full source URLs, query signatures, user paths, prompts, credentials, or image bytes. A source type is retained before a local upload key is resolved into a signed storage URL.

## Verification boundaries

Automated tests use fixture images, mocked DNS/storage/upstream calls and real anonymous Fastify route reads. They exercise public COS references, local uploads, signed URLs, cache reads, MIME/content validation, redirect/SSRF rejection, serializers, expiry, and unchanged text-to-image/TASK behavior. They make no paid generation calls. Live channel edit support and its exact serializer still need the channel's group-specific contract; a server-side public-route check cannot guarantee the upstream's independent DNS/allowlist accepts that host.
