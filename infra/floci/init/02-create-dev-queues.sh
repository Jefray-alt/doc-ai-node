#!/bin/sh
set -eu

main_queue=${SQS_QUEUE_NAME:?Set SQS_QUEUE_NAME in .env}
dead_letter_queue=${SQS_DLQ_NAME:?Set SQS_DLQ_NAME in .env}
lookup_error=$(mktemp)
trap 'rm -f "$lookup_error"' EXIT HUP INT TERM

queue_url() {
  queue_name=$1

  aws sqs get-queue-url \
    --queue-name "$queue_name" \
    --query QueueUrl \
    --output text 2>"$lookup_error"
}

ensure_queue() {
  queue_name=$1

  if queue_url "$queue_name" >/dev/null; then
    return 0
  else
    lookup_status=$?
  fi

  if ! grep -E 'AWS.SimpleQueueService.NonExistentQueue|QueueDoesNotExist' "$lookup_error" >/dev/null; then
    cat "$lookup_error" >&2
    return "$lookup_status"
  fi

  aws sqs create-queue --queue-name "$queue_name" >/dev/null
}

ensure_queue "$dead_letter_queue"
dead_letter_url=$(aws sqs get-queue-url \
  --queue-name "$dead_letter_queue" \
  --query QueueUrl \
  --output text)
dead_letter_arn=$(aws sqs get-queue-attributes \
  --queue-url "$dead_letter_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

aws sqs set-queue-attributes \
  --queue-url "$dead_letter_url" \
  --attributes '{"MessageRetentionPeriod":"1209600"}'

ensure_queue "$main_queue"
main_url=$(aws sqs get-queue-url \
  --queue-name "$main_queue" \
  --query QueueUrl \
  --output text)
main_attributes=$(printf \
  '{"VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","MessageRetentionPeriod":"345600","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":5}"}' \
  "$dead_letter_arn")

aws sqs set-queue-attributes \
  --queue-url "$main_url" \
  --attributes "$main_attributes"
