export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const SCAN_WORKER_CONFIG = Symbol('SCAN_WORKER_CONFIG');

export interface ScanWorkerConfig {
  queueUrl: string;
  quarantineBucket: string;
  concurrency: number;
  visibilityTimeoutSeconds: number;
  processingDeadlineMs: number;
  shutdownGraceMs: number;
  pollIntervalMs: number;
}

const DEFAULTS = {
  concurrency: 4,
  visibilityTimeoutSeconds: 120,
  processingDeadlineMs: 60_000,
  shutdownGraceMs: 65_000,
  pollIntervalMs: 1_000,
} as const;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getScanWorkerConfig(env: NodeJS.ProcessEnv = process.env): ScanWorkerConfig {
  const queueUrl = env.SQS_QUEUE_URL?.trim();
  if (!queueUrl) throw new Error('SQS_QUEUE_URL is required to start the scan worker');
  const quarantineBucket = env.S3_QUARANTINE_BUCKET?.trim();
  if (!quarantineBucket) throw new Error('S3_QUARANTINE_BUCKET is required to start the scan worker');

  const config: ScanWorkerConfig = {
    queueUrl,
    quarantineBucket,
    concurrency: positiveInteger(env.SCAN_WORKER_CONCURRENCY, DEFAULTS.concurrency, 'SCAN_WORKER_CONCURRENCY'),
    visibilityTimeoutSeconds: positiveInteger(env.SQS_VISIBILITY_TIMEOUT_SECONDS, DEFAULTS.visibilityTimeoutSeconds, 'SQS_VISIBILITY_TIMEOUT_SECONDS'),
    processingDeadlineMs: positiveInteger(env.SCAN_WORKER_DEADLINE_MS, DEFAULTS.processingDeadlineMs, 'SCAN_WORKER_DEADLINE_MS'),
    shutdownGraceMs: positiveInteger(env.SCAN_WORKER_SHUTDOWN_GRACE_MS, DEFAULTS.shutdownGraceMs, 'SCAN_WORKER_SHUTDOWN_GRACE_MS'),
    pollIntervalMs: positiveInteger(env.SCAN_WORKER_POLL_BACKOFF_MS, DEFAULTS.pollIntervalMs, 'SCAN_WORKER_POLL_BACKOFF_MS'),
  };
  if (config.visibilityTimeoutSeconds > 43_200) {
    throw new Error('SQS_VISIBILITY_TIMEOUT_SECONDS must not exceed 43200');
  }
  if (config.processingDeadlineMs >= config.visibilityTimeoutSeconds * 1_000) {
    throw new Error('SCAN_WORKER_DEADLINE_MS must be shorter than SQS visibility timeout');
  }
  if (config.shutdownGraceMs < config.processingDeadlineMs) {
    throw new Error('SCAN_WORKER_SHUTDOWN_GRACE_MS must be at least the processing deadline');
  }
  return config;
}
