#!/bin/sh
set -eu

ingestion_bucket=${S3_BUCKET_NAME:?Set S3_BUCKET_NAME in .env}
quarantine_bucket=${S3_QUARANTINE_BUCKET_NAME:?Set S3_QUARANTINE_BUCKET_NAME in .env}
scan_queue=${SQS_QUEUE_NAME:-doc-ai-malware-scan-results}
scan_dlq=${SQS_DLQ_NAME:-${scan_queue}-dlq}

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

aws s3api put-bucket-versioning \
  --bucket "$quarantine_bucket" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-cors \
  --bucket "$quarantine_bucket" \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["POST"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'

ensure_queue() {
  name=$1
  queue_url=$(aws sqs get-queue-url --queue-name "$name" --query QueueUrl --output text 2>/dev/null || true)
  if [ -z "$queue_url" ] || [ "$queue_url" = None ]; then
    queue_url=$(aws sqs create-queue --queue-name "$name" --query QueueUrl --output text)
  fi
  printf '%s\n' "$queue_url"
}

dlq_url=$(ensure_queue "$scan_dlq")
queue_url=$(ensure_queue "$scan_queue")
dlq_arn=$(aws sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)
queue_arn=$(aws sqs get-queue-attributes \
  --queue-url "$queue_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)
redrive_allow_policy=$(printf '{"redrivePermission":"byQueue","sourceQueueArns":["%s"]}' "$queue_arn" | sed 's/"/\\"/g')
redrive_policy=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$dlq_arn" | sed 's/"/\\"/g')

aws sqs set-queue-attributes \
  --queue-url "$dlq_url" \
  --attributes "{\"MessageRetentionPeriod\":\"1209600\",\"RedriveAllowPolicy\":\"$redrive_allow_policy\"}"
aws sqs set-queue-attributes \
  --queue-url "$queue_url" \
  --attributes "{\"VisibilityTimeout\":\"120\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"$redrive_policy\"}"
