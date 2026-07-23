# OSS public bridge lifecycle

Aliyun OSS is only a temporary public-access bridge. Generated results remain
in `IMAGE_RESULT_STORE_DIR`, and uploaded references are cached temporarily
under `IMAGE_RESULT_STORE_DIR/reference-images`.

Configure two Bucket lifecycle rules:

- Prefix `reference-images/`: permanently delete after 1 day (24 hours).
- Prefix `generated-images/`: permanently delete after 1 day (24 hours).

Do not apply these rules to the whole Bucket. Reference-image URLs are signed
for 30 minutes because the upstream AI only needs to read them during request
processing. Generated-image download URLs are signed for 24 hours. Lifecycle
rules clean up objects even if explicit deletion does not complete.
