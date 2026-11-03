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
fi
if [ "$1 $2" = 'sqs list-queues' ]; then
  if [ "${AWS_EXISTING_QUEUES:-0}" = 1 ]; then
    case "$*" in
      *doc-ai-local-document-jobs-dlq*) printf '%s\n' 'http://localhost:4566/000000000000/doc-ai-local-document-jobs-dlq' ;;
      *) printf '%s\n' 'http://localhost:4566/000000000000/doc-ai-local-document-jobs' ;;
    esac
  else
    printf '%s\n' 'None'
  fi
fi
if [ "$1 $2" = 'sqs create-queue' ]; then
  case "$*" in
    *doc-ai-local-document-jobs-dlq*) printf '%s\n' 'http://localhost:4566/000000000000/doc-ai-local-document-jobs-dlq' ;;
    *) printf '%s\n' 'http://localhost:4566/000000000000/doc-ai-local-document-jobs' ;;
  esac
fi
if [ "$1 $2" = 'sqs get-queue-attributes' ]; then
  printf '%s\n' 'arn:aws:sqs:us-east-1:000000000000:doc-ai-local-document-jobs-dlq'
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
grep -F 'AllowedMethods":["POST"]' "$AWS_LOG" >/dev/null
grep -F 'AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"]' "$AWS_LOG" >/dev/null

export AWS_EXISTING_BUCKETS=1
export AWS_EXISTING_QUEUES=1
sh "$repo_root/infra/floci/init/01-create-dev-bucket.sh"
create_count=$(grep -c 'create-bucket --bucket' "$AWS_LOG")
test "$create_count" -eq 2
queue_create_count=$(grep -c 'sqs create-queue' "$AWS_LOG")
test "$queue_create_count" -eq 2
grep -F '"MessageRetentionPeriod":"1209600"' "$AWS_LOG" >/dev/null
grep -F '"DelaySeconds":"0"' "$AWS_LOG" >/dev/null
grep -F '"ReceiveMessageWaitTimeSeconds":"20"' "$AWS_LOG" >/dev/null
grep -F '"VisibilityTimeout":"120"' "$AWS_LOG" >/dev/null
grep -F 'deadLetterTargetArn' "$AWS_LOG" >/dev/null
grep -F 'maxReceiveCount' "$AWS_LOG" >/dev/null
grep -F '\"5\"' "$AWS_LOG" >/dev/null

echo 'Floci initialization test passed'
