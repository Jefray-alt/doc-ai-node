#!/bin/sh
set -eu

pdf_bucket=${S3_BUCKET_NAME:?Set S3_BUCKET_NAME in .env}

ensure_bucket() {
  bucket=$1
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
}

ensure_bucket "$pdf_bucket"

aws s3api put-bucket-cors \
  --bucket "$pdf_bucket" \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["POST"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'
