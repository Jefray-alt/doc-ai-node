import { randomUUID } from 'node:crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadBackendEnv } from './backend-env.mjs';

const outcomes = {
  clean: ['COMPLETED', 'NO_THREATS_FOUND'],
  threats: ['COMPLETED', 'THREATS_FOUND'],
  unsupported: ['SKIPPED', 'UNSUPPORTED'],
  accessdenied: ['SKIPPED', 'ACCESS_DENIED'],
  failed: ['FAILED', 'FAILED'],
};

function usage() {
  return 'Usage: npm run simulate:scan -- <incoming-key> [clean|threats|unsupported|accessdenied|failed] [--version-id <id>]';
}

function parseArgs(args) {
  const [key, ...tail] = args;
  let outcome = 'clean';
  if (tail[0] && !tail[0].startsWith('--')) outcome = tail.shift();
  if (!key || !Object.hasOwn(outcomes, outcome)) throw new Error(usage());
  let versionId;
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] !== '--version-id' || !tail[index + 1] || versionId) throw new Error(usage());
    versionId = tail[index + 1];
    index += 1;
  }
  return { key, outcome, versionId };
}

loadBackendEnv();
const { key, outcome, versionId: requestedVersionId } = parseArgs(process.argv.slice(2));
const bucketName = process.env.S3_QUARANTINE_BUCKET;
const queueUrl = process.env.SQS_QUEUE_URL;
if (!bucketName || !queueUrl) throw new Error('S3_QUARANTINE_BUCKET and SQS_QUEUE_URL are required');
const region = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  : undefined;
const s3 = new S3Client({
  region,
  ...(process.env.S3_ENDPOINT_URL ? { endpoint: process.env.S3_ENDPOINT_URL, forcePathStyle: true } : {}),
  ...(credentials ? { credentials } : {}),
});
const sqs = new SQSClient({
  region,
  ...(process.env.SQS_ENDPOINT_URL ? { endpoint: process.env.SQS_ENDPOINT_URL } : {}),
  ...(credentials ? { credentials } : {}),
});

try {
  const head = await s3.send(new HeadObjectCommand({
    Bucket: bucketName,
    Key: key,
    ...(requestedVersionId ? { VersionId: requestedVersionId } : {}),
  }));
  const exactVersionId = requestedVersionId ?? head.VersionId;
  if (!exactVersionId || exactVersionId.toLowerCase() === 'null') {
    throw new Error('The quarantine object has no non-null version ID; enable bucket versioning first');
  }
  if (!head.ETag) throw new Error('The quarantine object does not have an ETag');
  const [scanStatus, scanResultStatus] = outcomes[outcome];
  const account = process.env.AWS_ACCOUNT_ID ?? '000000000000';
  const event = {
    version: '0',
    id: randomUUID(),
    'detail-type': 'GuardDuty Malware Protection Object Scan Result',
    source: 'aws.guardduty',
    account,
    time: new Date().toISOString(),
    region,
    resources: [`arn:aws:guardduty:${region}:${account}:malware-protection-plan/local-simulator`],
    detail: {
      schemaVersion: '1.0',
      scanStatus,
      resourceType: 'S3_OBJECT',
      s3ObjectDetails: {
        bucketName,
        objectKey: key,
        eTag: head.ETag,
        versionId: exactVersionId,
        s3Throttled: false,
      },
      scanResultDetails: {
        scanResultStatus,
        threats: outcome === 'threats' ? [{ name: 'simulated threat', source: 'LOCAL_SIMULATOR', itemDetails: [] }] : null,
        statusReasons: outcome === 'unsupported' ? ['LOCAL_SIMULATOR'] : outcome === 'accessdenied' ? ['LOCAL_SIMULATOR'] : null,
      },
    },
  };
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) }));
  console.log(`Published ${outcome} scan event for s3://${bucketName}/${key} version ${exactVersionId}`);
} finally {
  s3.destroy();
  sqs.destroy();
}
