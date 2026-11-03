#!/bin/sh
set -eu

ingestion_bucket=${S3_BUCKET_NAME:?Set S3_BUCKET_NAME in .env}
quarantine_bucket=${S3_QUARANTINE_BUCKET_NAME:?Set S3_QUARANTINE_BUCKET_NAME in .env}
jobs_queue=${SQS_QUEUE_NAME:-doc-ai-local-document-jobs}
jobs_dlq=${SQS_DLQ_NAME:-doc-ai-local-document-jobs-dlq}

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

ensure_bucket "$ingestion_bucket"
ensure_bucket "$quarantine_bucket"

ensure_queue() {
  queue_name=$1
  attributes=$2
  queue_url=$(aws sqs list-queues \
    --queue-name-prefix "$queue_name" \
    --query "QueueUrls[?ends_with(@, '/$queue_name')] | [0]" \
    --output text)

  if [ "$queue_url" = "None" ] || [ -z "$queue_url" ]; then
    queue_url=$(aws sqs create-queue \
      --queue-name "$queue_name" \
      --attributes "$attributes" \
      --query QueueUrl \
      --output text)
  else
    aws sqs set-queue-attributes --queue-url "$queue_url" --attributes "$attributes"
  fi

  printf '%s\n' "$queue_url"
}

dlq_url=$(ensure_queue "$jobs_dlq" '{"MessageRetentionPeriod":"1209600"}')
dlq_arn=$(aws sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)
redrive_policy=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$dlq_arn")
ensure_queue "$jobs_queue" "{\"DelaySeconds\":\"0\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"VisibilityTimeout\":\"120\",\"MessageRetentionPeriod\":\"604800\",\"RedrivePolicy\":\"$(printf '%s' "$redrive_policy" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}" >/dev/null

aws s3api put-bucket-cors \
  --bucket "$quarantine_bucket" \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["POST"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'
