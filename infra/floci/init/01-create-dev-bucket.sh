#!/bin/sh
set -eu

endpoint=http://localhost:4566
bucket=doc-ai-local-pdfs

bucket_count=$(aws --endpoint-url "$endpoint" --region us-east-1 \
  s3api list-buckets \
  --query "Buckets[?Name=='$bucket'] | length(@)" \
  --output text)

case "$bucket_count" in
  0)
    aws --endpoint-url "$endpoint" --region us-east-1 \
      s3api create-bucket --bucket "$bucket"
    ;;
  1)
    ;;
  *)
    echo "Unexpected bucket count for $bucket: $bucket_count" >&2
    exit 1
    ;;
esac
