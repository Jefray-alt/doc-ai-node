#!/bin/sh
set -eu

suffix="$(date +%s)-$$"
main_name="doc-ai-sqs-smoke-$suffix"
dead_name="doc-ai-sqs-smoke-$suffix-dlq"
main_url=
dead_url=
payload="floci-sqs-smoke-$suffix"

aws() {
  docker compose exec -T floci aws "$@"
}

cleanup_queue() {
  queue_name=$1

  if queue_lookup=$(aws sqs get-queue-url \
    --queue-name "$queue_name" \
    --query QueueUrl \
    --output text 2>&1); then
    queue_url=$queue_lookup
    if ! aws sqs delete-queue --queue-url "$queue_url" >/dev/null 2>&1; then
      echo "Floci SQS smoke check: could not remove disposable queue $queue_name" >&2
      cleanup_failed=1
    fi
  else
    case "$queue_lookup" in
      *AWS.SimpleQueueService.NonExistentQueue*|*QueueDoesNotExist*) ;;
      *)
        echo "Floci SQS smoke check: could not look up disposable queue $queue_name: $queue_lookup" >&2
        cleanup_failed=1
        ;;
    esac
  fi
}

cleanup() {
  exit_status=$?
  trap - EXIT
  cleanup_failed=0
  cleanup_queue "$main_name"
  cleanup_queue "$dead_name"
  if [ "$cleanup_failed" -eq 1 ] && [ "$exit_status" -eq 0 ]; then
    exit_status=1
  fi
  exit "$exit_status"
}

fail() {
  echo "Floci SQS smoke check: $*" >&2
  exit 1
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if ! docker compose exec -T \
  -e SQS_QUEUE_NAME="$main_name" \
  -e SQS_DLQ_NAME="$dead_name" \
  floci sh /etc/floci/init/start.d/02-create-dev-queues.sh; then
  fail "could not initialize disposable queues $main_name and $dead_name"
fi

main_url=$(aws sqs get-queue-url \
  --queue-name "$main_name" \
  --query QueueUrl \
  --output text) || fail "could not find disposable work queue $main_name"
dead_url=$(aws sqs get-queue-url \
  --queue-name "$dead_name" \
  --query QueueUrl \
  --output text) || fail "could not find disposable dead-letter queue $dead_name"

get_attribute() {
  queue_url=$1
  attribute_name=$2

  aws sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names "$attribute_name" \
    --query "Attributes.$attribute_name" \
    --output text
}

check_attribute() {
  queue_url=$1
  attribute_name=$2
  expected=$3
  actual=$(get_attribute "$queue_url" "$attribute_name") ||
    fail "could not read $attribute_name from a disposable queue"
  if [ "$actual" != "$expected" ]; then
    fail "$attribute_name was $actual; expected $expected"
  fi
}

check_attribute "$main_url" VisibilityTimeout 30
check_attribute "$main_url" ReceiveMessageWaitTimeSeconds 20
check_attribute "$main_url" MessageRetentionPeriod 345600
check_attribute "$dead_url" MessageRetentionPeriod 1209600

dead_arn=$(get_attribute "$dead_url" QueueArn) ||
  fail "could not read disposable dead-letter queue ARN"
redrive_policy=$(get_attribute "$main_url" RedrivePolicy) ||
  fail "could not read disposable work queue redrive policy"
if ! docker compose exec -T \
  -e REDRIVE_POLICY="$redrive_policy" \
  -e EXPECTED_DEAD_ARN="$dead_arn" \
  floci python3 -c '
import json
import os

policy = json.loads(os.environ["REDRIVE_POLICY"])
assert policy.get("deadLetterTargetArn") == os.environ["EXPECTED_DEAD_ARN"], policy
assert policy.get("maxReceiveCount") == 5, policy
'; then
  fail "redrive policy did not point to the disposable DLQ with maxReceiveCount 5"
fi

aws sqs send-message \
  --queue-url "$main_url" \
  --message-body "$payload" >/dev/null || fail "could not send test message"

receive_message() {
  queue_url=$1
  wait_seconds=$2
  visibility_timeout=${3-}

  set -- sqs receive-message \
    --queue-url "$queue_url" \
    --wait-time-seconds "$wait_seconds" \
    --attribute-names ApproximateReceiveCount \
    --output json
  if [ -n "$visibility_timeout" ]; then
    set -- "$@" --visibility-timeout "$visibility_timeout"
  fi
  message_json=$(aws "$@") || return $?
  docker compose exec -T \
    -e MESSAGE_JSON="$message_json" \
    floci python3 -c '
import json
import os

messages = json.loads(os.environ["MESSAGE_JSON"] or "{}").get("Messages", [])
if messages:
    message = messages[0]
    print(message["Body"] + "\t" + message["ReceiptHandle"] + "\t" +
          message["Attributes"]["ApproximateReceiveCount"])
'
}

# Zero visibility makes a no-op delete visible to the absence check immediately.
received=$(receive_message "$main_url" 1 0) || fail "could not receive test message"
actual_body=${received%%"$(printf '\t')"*}
if [ "$actual_body" != "$payload" ]; then
  fail "received an unexpected work queue body: $actual_body"
fi
receipt=${received#*"$(printf '\t')"}
receipt=${receipt%%"$(printf '\t')"*}
[ -n "$receipt" ] || fail "received message had no receipt handle"

aws sqs delete-message \
  --queue-url "$main_url" \
  --receipt-handle "$receipt" >/dev/null || fail "could not delete test message"
deleted=$(receive_message "$main_url" 1) ||
  fail "could not verify deleted message absence"
if [ -n "$deleted" ]; then
  fail "deleted work queue message was still available"
fi

# Keep the normal queue defaults checked above, then make this disposable test
# fast enough to exercise redrive without waiting for the production visibility.
aws sqs set-queue-attributes \
  --queue-url "$main_url" \
  --attributes '{"VisibilityTimeout":"1","ReceiveMessageWaitTimeSeconds":"0"}' ||
  fail "could not shorten disposable queue visibility for redrive check"
aws sqs send-message \
  --queue-url "$main_url" \
  --message-body "$payload" >/dev/null || fail "could not send redrive test message"

receive_count=0
attempt=0
while [ "$attempt" -lt 15 ]; do
  attempt=$((attempt + 1))
  redrive_received=$(receive_message "$main_url" 0) ||
    fail "could not receive redrive test message"
  if [ -n "$redrive_received" ]; then
    redrive_body=${redrive_received%%"$(printf '\t')"*}
    redrive_details=${redrive_received#*"$(printf '\t')"}
    receive_count=${redrive_details##*"$(printf '\t')"}
    if [ "$redrive_body" != "$payload" ]; then
      fail "received an unexpected redrive test body: $redrive_body"
    fi
  fi

  dead_received=$(receive_message "$dead_url" 1) ||
    fail "could not receive from disposable DLQ"
  if [ -n "$dead_received" ]; then
    dead_body=${dead_received%%"$(printf '\t')"*}
    [ "$dead_body" = "$payload" ] ||
      fail "DLQ contained an unexpected body: $dead_body"
    if [ "$receive_count" -lt 5 ]; then
      fail "message reached DLQ after only $receive_count observed work-queue receives"
    fi
    echo "Floci SQS smoke check passed (redrive count $receive_count)"
    exit 0
  fi
  sleep 1
done

fail "message was not delivered to disposable DLQ $dead_name after $attempt work-queue receives"
