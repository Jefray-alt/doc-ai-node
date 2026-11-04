# Quarantine scan operations

This guide describes the production path from an uploaded object to the clean
bucket. Production AWS resources are documented here; this repository only
configures the local Floci queues and does not deploy AWS resources or start a
malware scanner.

## Event path

Enable GuardDuty Malware Protection for S3 on the versioned quarantine bucket
and limit the protected prefix to `incoming/`. Route the GuardDuty scan result
event from the default EventBridge bus directly to the standard SQS queue
`doc-ai-malware-scan-results`. Match all of the following:

```json
{
  "source": ["aws.guardduty"],
  "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
  "detail": {
    "resourceType": ["S3_OBJECT"],
    "s3ObjectDetails": {
      "bucketName": ["<quarantine-bucket>"],
      "objectKey": [{ "prefix": "incoming/" }]
    }
  }
}
```

Keep the default EventBridge envelope in the SQS message body. The worker uses
the event's bucket, key, exact `versionId`, ETag, scan status, and result. GuardDuty
may send duplicate events, so promotion is idempotent. The queue's resource
policy should grant `events.amazonaws.com` only `sqs:SendMessage`, conditioned
on the EventBridge rule ARN and source account. Configure a separate EventBridge
delivery DLQ for target delivery failures; it is distinct from the worker's
processing DLQ.

Run the Nest scan worker as an independently scaled process. Its default
settings are four concurrent messages, a 60-second processing deadline, a
65-second shutdown grace period, and a 120-second SQS visibility timeout. Keep
the deadline below visibility and keep shutdown grace at least as long as the
deadline. Scale workers against queue age and backlog; cap concurrency at a value
the service and S3 copy path can sustain.

## Permissions

Give the worker identity only the operations it needs:

- `sqs:ReceiveMessage` and `sqs:DeleteMessage` on
  `doc-ai-malware-scan-results`.
- `s3:GetObjectVersion` on `arn:aws:s3:::<quarantine-bucket>/incoming/*`.
- `s3:GetObject` and `s3:PutObject` on
  `arn:aws:s3:::<clean-bucket>/cleared/*`, plus `s3:ListBucket` on the clean
  bucket. The worker checks whether the deterministic destination already
  exists; `ListBucket` lets a missing `HeadObject` return 404 rather than 403.
- `s3:GetObjectTagging` and `s3:GetObjectVersionTagging` on quarantine objects,
  plus `s3:PutObjectTagging` on clean objects, because `CopyObject` copies tags
  by default. Add `s3:PutObjectVersionTagging` if a later operation updates a
  specific clean-object version.
- KMS decrypt on the source key and encrypt/data-key permissions on the clean
  bucket key, with matching key-policy grants, when either bucket uses a
  customer-managed key.

Configure GuardDuty's own Malware Protection role and its EventBridge target
permissions separately from the worker role. Grant the EventBridge delivery
DLQ `sqs:SendMessage` only to the rule ARN and account that own that rule.

## Queue and retention settings

Use a standard processing queue with 120-second visibility, 20-second long
polling, four-day message retention, and a redrive policy to
`doc-ai-malware-scan-results-dlq` after five receives. Retain processing-DLQ
messages for 14 days. Alarm on any processing-DLQ messages and any EventBridge
delivery-DLQ messages. Alert on `ApproximateAgeOfOldestMessage`, visible backlog,
and not-visible messages; interpret SQS queue counts as approximate metrics.

Retain current and noncurrent quarantine versions for seven days through S3
lifecycle rules. This is enough for normal processing, but it is shorter than
the 14-day processing-DLQ retention: a message replayed after its source version
expires cannot be promoted. If operators need the full manual-replay window,
retain source versions for at least 14 days or copy the source version to
separately controlled recovery storage before expiry. Objects uploaded before
quarantine versioning was enabled have no usable version ID and must be uploaded
again before they can enter this flow.

## Local simulation

Start local Floci from the repository root using the instructions in the root
README. From `backend/`, the simulator reads the selected quarantine object's
current or specified version and ETag, then publishes a GuardDuty-shaped event
directly to the configured SQS queue:

```sh
npm run simulate:scan -- incoming/<uuid>.pdf
npm run simulate:scan -- incoming/<uuid>.pdf threats
npm run simulate:scan -- incoming/<uuid>.pdf clean --version-id <version-id>
```

Supported outcomes are `clean`, `threats`, `unsupported`, `accessdenied`, and
`failed`. The tool does not scan file bytes and must only be used for local
workflow simulation. Set `S3_ENDPOINT_URL` and `SQS_ENDPOINT_URL` explicitly
when testing against an isolated Floci instance.

## AWS references

- [GuardDuty S3 scan result EventBridge events](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-with-eventbridge-s3-malware-protection.html)
- [EventBridge resource-based policies for SQS targets](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [EventBridge target delivery dead-letter queues](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html)
- [SQS visibility timeout and processing guidance](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [SQS CloudWatch metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)
- [S3 lifecycle expiration with versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html)
- [S3 object tags and copy behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-tagging.html)
