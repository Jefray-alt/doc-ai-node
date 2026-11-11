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
service=$1
operation=$2
shift 2

case "$service $operation" in
  'sqs get-queue-url')
    name=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --queue-name) name=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$name" ] || exit 90
    case "${AWS_FAIL:-}" in lookup) echo 'simulated lookup failure' >&2; exit 1 ;; esac
    if [ -f "$AWS_STATE/$name" ]; then
      printf 'http://localhost:4566/queue/%s\n' "$name"
    else
      echo 'An error occurred (AWS.SimpleQueueService.NonExistentQueue)' >&2
      exit 254
    fi
    ;;
  'sqs create-queue')
    name=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --queue-name) name=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$name" ] || exit 90
    [ "${AWS_FAIL:-}" != create ] || { echo 'simulated create failure' >&2; exit 22; }
    : > "$AWS_STATE/$name"
    printf 'http://localhost:4566/queue/%s\n' "$name"
    ;;
  'sqs get-queue-attributes')
    [ "${AWS_FAIL:-}" != get-attributes ] || { echo 'simulated get attributes failure' >&2; exit 23; }
    queue_url=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --queue-url) queue_url=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    queue_name=${queue_url##*/}
    printf 'arn:aws:sqs:us-east-1:123456789012:%s\n' "$queue_name"
    ;;
  'sqs set-queue-attributes')
    [ "${AWS_FAIL:-}" != set-attributes ] || { echo 'simulated set attributes failure' >&2; exit 24; }
    ;;
  *) echo "unexpected aws command: $service $operation $*" >&2; exit 91 ;;
esac
AWS
chmod +x "$temp_dir/bin/aws"
export AWS_LOG="$temp_dir/aws.log"
export AWS_STATE="$temp_dir/state"
mkdir "$AWS_STATE"
export PATH="$temp_dir/bin:$PATH"
export SQS_QUEUE_NAME=doc-ai-local-pdf-validation
export SQS_DLQ_NAME=doc-ai-local-pdf-validation-dlq

hook="$repo_root/infra/floci/init/02-create-dev-queues.sh"
run_hook() { sh "$hook"; }

# Fresh setup creates the DLQ before the main queue and applies both policies.
run_hook
create_lines=$(grep 'sqs create-queue' "$AWS_LOG")
first_create=$(printf '%s\n' "$create_lines" | sed -n '1p')
second_create=$(printf '%s\n' "$create_lines" | sed -n '2p')
case "$first_create" in *"$SQS_DLQ_NAME"*) ;; *) echo 'DLQ was not created first' >&2; exit 1 ;; esac
case "$second_create" in *"$SQS_QUEUE_NAME"*) ;; *) echo 'main queue was not created second' >&2; exit 1 ;; esac
grep -F '"MessageRetentionPeriod":"1209600"' "$AWS_LOG" >/dev/null
grep -F '"VisibilityTimeout":"30"' "$AWS_LOG" >/dev/null
grep -F '"ReceiveMessageWaitTimeSeconds":"20"' "$AWS_LOG" >/dev/null
grep -F '"MessageRetentionPeriod":"345600"' "$AWS_LOG" >/dev/null
grep -F '\"maxReceiveCount\":5' "$AWS_LOG" >/dev/null
grep -F 'arn:aws:sqs:us-east-1:123456789012:doc-ai-local-pdf-validation-dlq' "$AWS_LOG" >/dev/null

# Existing queues are reconciled without recreation or message-destructive calls.
: > "$AWS_LOG"
run_hook
test "$(grep -c 'sqs create-queue' "$AWS_LOG" || :)" -eq 0
if grep -E 'purge-queue|delete-queue' "$AWS_LOG" >/dev/null; then
  echo 'existing queue reconciliation used a destructive operation' >&2
  exit 1
fi
grep -F 'sqs set-queue-attributes' "$AWS_LOG" >/dev/null

# Caller overrides are used verbatim.
: > "$AWS_LOG"
SQS_QUEUE_NAME=custom-main SQS_DLQ_NAME=custom-dead run_hook
grep -F 'custom-dead' "$AWS_LOG" >/dev/null
grep -F 'custom-main' "$AWS_LOG" >/dev/null

# Both queue names are required by the hook.
if missing_main=$(env -u SQS_QUEUE_NAME sh "$hook" 2>&1); then
  echo 'hook accepted missing SQS_QUEUE_NAME' >&2
  exit 1
fi
case "$missing_main" in
  *'Set SQS_QUEUE_NAME in .env'*) ;;
  *) echo "missing SQS_QUEUE_NAME produced unexpected error: $missing_main" >&2; exit 1 ;;
esac
if missing_dlq=$(env -u SQS_DLQ_NAME sh "$hook" 2>&1); then
  echo 'hook accepted missing SQS_DLQ_NAME' >&2
  exit 1
fi
case "$missing_dlq" in
  *'Set SQS_DLQ_NAME in .env'*) ;;
  *) echo "missing SQS_DLQ_NAME produced unexpected error: $missing_dlq" >&2; exit 1 ;;
esac

# Arbitrary lookup and AWS operation failures propagate; only a confirmed missing queue permits creation.
for failure in lookup create get-attributes set-attributes; do
  rm -f "$AWS_STATE"/*
  : > "$AWS_LOG"
  if AWS_FAIL=$failure run_hook >/dev/null 2>&1; then
    echo "expected $failure failure to propagate" >&2
    exit 1
  fi
  if [ "$failure" = lookup ]; then
    if grep 'sqs create-queue' "$AWS_LOG" >/dev/null; then
      echo 'queue created after an arbitrary lookup failure' >&2
      exit 1
    fi
  fi
done

echo 'Floci SQS initialization test passed'
