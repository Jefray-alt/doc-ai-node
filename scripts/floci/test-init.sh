#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
mkdir "$temp_dir/bin"
cat >"$temp_dir/bin/aws" <<'AWS'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$AWS_LOG"
if [ "$1 $2" = 's3api list-buckets' ]; then
  printf '%s\n' "${AWS_EXISTING_BUCKETS:-0}"
elif [ "$1 $2" = 'sqs get-queue-url' ] || [ "$1 $2" = 'sqs create-queue' ]; then
  operation=$2
  while [ "$#" -gt 0 ]; do
    if [ "$1" = '--queue-name' ]; then shift; name=$1; fi
    shift
  done
  if [ "$operation" = 'get-queue-url' ] && ! grep -F "create-queue --queue-name $name " "$AWS_LOG" >/dev/null; then
    exit 1
  fi
  printf 'http://localhost:4567/000000000000/%s\n' "$name"
elif [ "$1 $2" = 'sqs get-queue-attributes' ]; then
  case "$*" in
    *doc-ai-malware-scan-results-dlq*) queue=doc-ai-malware-scan-results-dlq ;;
    *) queue=doc-ai-malware-scan-results ;;
  esac
  printf '{"Attributes":{"QueueArn":"arn:aws:sqs:us-east-1:000000000000:%s"}}\n' "$queue"
fi
AWS
chmod +x "$temp_dir/bin/aws"
export AWS_LOG="$temp_dir/aws.log"
export S3_BUCKET_NAME=doc-ai-local-pdfs
export S3_QUARANTINE_BUCKET_NAME=doc-ai-local-quarantine
export PATH="$temp_dir/bin:$PATH"

sh "$repo_root/infra/floci/init/01-create-dev-bucket.sh"

grep -F 'create-bucket --bucket doc-ai-local-pdfs' "$AWS_LOG" >/dev/null
grep -F 'create-bucket --bucket doc-ai-local-quarantine' "$AWS_LOG" >/dev/null
grep -F 'put-bucket-cors --bucket doc-ai-local-quarantine' "$AWS_LOG" >/dev/null
grep -F 'put-bucket-versioning --bucket doc-ai-local-quarantine --versioning-configuration Status=Enabled' "$AWS_LOG" >/dev/null
grep -F 'AllowedMethods":["POST"]' "$AWS_LOG" >/dev/null
grep -F 'AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"]' "$AWS_LOG" >/dev/null
grep -F 'create-queue --queue-name doc-ai-malware-scan-results-dlq' "$AWS_LOG" >/dev/null
grep -F 'create-queue --queue-name doc-ai-malware-scan-results' "$AWS_LOG" >/dev/null
grep -F 'VisibilityTimeout":"120' "$AWS_LOG" >/dev/null
grep -F 'maxReceiveCount' "$AWS_LOG" >/dev/null
grep -F 'redrivePermission' "$AWS_LOG" >/dev/null
grep -F 'deadLetterTargetArn' "$AWS_LOG" >/dev/null

export AWS_EXISTING_BUCKETS=1
sh "$repo_root/infra/floci/init/01-create-dev-bucket.sh"
create_count=$(grep -c 'create-bucket --bucket' "$AWS_LOG")
test "$create_count" -eq 2
grep -F 'set-queue-attributes' "$AWS_LOG" >/dev/null
grep -F 'put-bucket-versioning --bucket doc-ai-local-quarantine --versioning-configuration Status=Enabled' "$AWS_LOG" >/dev/null
create_queue_count=$(grep -c 'create-queue --queue-name' "$AWS_LOG")
test "$create_queue_count" -eq 2
set_queue_count=$(grep -c 'set-queue-attributes' "$AWS_LOG")
test "$set_queue_count" -eq 4

echo 'Floci initialization test passed'
