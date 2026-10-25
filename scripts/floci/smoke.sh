#!/bin/sh
set -eu

bucket=doc-ai-local-pdfs
key="smoke/$(date +%s)-$$.txt"
payload="floci-smoke-$(date +%s)-$$"
uploaded=0

aws() {
  docker compose exec -T floci aws "$@"
}

cleanup() {
  if [ "$uploaded" -eq 1 ]; then
    aws s3api delete-object --bucket "$bucket" --key "$key" >/dev/null 2>&1 || :
  fi
}
trap cleanup EXIT HUP INT TERM

if ! printf '%s' "$payload" | aws s3 cp - "s3://$bucket/$key"; then
  echo "Floci smoke check: upload failed" >&2
  exit 1
fi
uploaded=1

actual=$(aws s3 cp "s3://$bucket/$key" -) || {
  echo "Floci smoke check: read failed" >&2
  exit 1
}
if [ "$actual" != "$payload" ]; then
  echo "Floci smoke check: downloaded bytes did not match" >&2
  exit 1
fi

aws s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
uploaded=0
aws s3api head-bucket --bucket "$bucket" >/dev/null
if missing=$(aws s3api head-object --bucket "$bucket" --key "$key" 2>&1); then
  echo "Floci smoke check: deleted object is still present" >&2
  exit 1
fi
case "$missing" in
  *"(404)"*) ;;
  *)
    echo "Floci smoke check: could not verify object absence: $missing" >&2
    exit 1
    ;;
esac

echo "Floci smoke check passed"
