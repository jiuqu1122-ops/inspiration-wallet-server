# Object storage lifecycle

The active object storage provider is selected with `STORAGE_PROVIDER` and can
be either Aliyun OSS or Tencent COS. Object keys are identical in both buckets.
Generated image results also remain in `IMAGE_RESULT_STORE_DIR`.

Configure two Bucket lifecycle rules:

- Prefix `reference-images/`: permanently delete after 1 day (24 hours).
- Prefix `generated-images/`: permanently delete after 1 day (24 hours).

Do not apply these rules to the whole Bucket, and do not add a provider-specific
prefix. URLs are signed for `STORAGE_SIGNED_URL_EXPIRES_SECONDS`; lifecycle rules
clean up temporary objects even if explicit deletion does not complete. Review
the retention requirement for `generated-videos/` separately because videos are
served from object storage rather than the local image-result volume.
