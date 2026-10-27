#!/bin/sh
set -eu

bucket=${S3_BUCKET_NAME:?Set S3_BUCKET_NAME in .env}

bucket_count=$(aws \
  s3api list-buckets \
  --query "Buckets[?Name=='$bucket'] | length(@)" \
  --output text)

case "$bucket_count" in
  0)
    aws s3api create-bucket --bucket "$bucket"
    ;;
  1)
    ;;
  *)
    echo "Unexpected bucket count for $bucket: $bucket_count" >&2
    exit 1
    ;;
esac
