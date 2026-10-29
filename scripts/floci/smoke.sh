#!/bin/sh
set -eu

ingestion_bucket=$(docker compose exec -T floci sh -c \
  'printf "%s" "${S3_BUCKET_NAME:?Set S3_BUCKET_NAME in .env}"')
quarantine_bucket=$(docker compose exec -T floci sh -c \
  'printf "%s" "${S3_QUARANTINE_BUCKET_NAME:?Set S3_QUARANTINE_BUCKET_NAME in .env}"')
payload="floci-smoke-$(date +%s)-$$"
uploaded=0
bucket=
key=
version_id=

aws() {
  docker compose exec -T floci aws "$@"
}

cleanup() {
  if [ "$uploaded" -eq 1 ]; then
    if [ -n "$version_id" ] && [ "$version_id" != None ]; then
      aws s3api delete-object --bucket "$bucket" --key "$key" --version-id "$version_id" >/dev/null 2>&1 || :
    else
      aws s3api delete-object --bucket "$bucket" --key "$key" >/dev/null 2>&1 || :
    fi
  fi
}
trap cleanup EXIT HUP INT TERM

check_bucket() {
  bucket=$1
  key="smoke/$(date +%s)-$$.txt"

  if ! printf '%s' "$payload" | aws s3 cp - "s3://$bucket/$key"; then
    echo "Floci smoke check: upload failed for $bucket" >&2
    exit 1
  fi
  uploaded=1
  version_id=$(aws s3api head-object --bucket "$bucket" --key "$key" --query VersionId --output text)

  actual=$(aws s3 cp "s3://$bucket/$key" -) || {
    echo "Floci smoke check: read failed for $bucket" >&2
    exit 1
  }
  if [ "$actual" != "$payload" ]; then
    echo "Floci smoke check: downloaded bytes did not match in $bucket" >&2
    exit 1
  fi

  if [ -n "$version_id" ] && [ "$version_id" != None ]; then
    aws s3api delete-object --bucket "$bucket" --key "$key" --version-id "$version_id" >/dev/null
  else
    aws s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
  fi
  uploaded=0
  version_id=
  aws s3api head-bucket --bucket "$bucket" >/dev/null
  if missing=$(aws s3api head-object --bucket "$bucket" --key "$key" 2>&1); then
    echo "Floci smoke check: deleted object is still present in $bucket" >&2
    exit 1
  fi
  case "$missing" in
    *"(404)"*) ;;
    *)
      echo "Floci smoke check: could not verify object absence in $bucket: $missing" >&2
      exit 1
      ;;
  esac
}

check_bucket "$ingestion_bucket"
check_bucket "$quarantine_bucket"

echo "Floci smoke check passed"
