export interface WorkerConfig {
  databaseUrl: string;
  queueUrl: string;
  dlqUrl: string;
  bucket: string;
  pollWaitSeconds: number;
  receiveMax: number;
  visibilityTimeoutSeconds: number;
  leaseMs: number;
  heartbeatMs: number;
  retryDelaySeconds: number;
  retryDelayMaxSeconds: number;
  s3EndpointUrl?: string;
  sqsEndpointUrl?: string;
  awsRegion: string;
}

export function parseWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
    return value;
  };

  const config: WorkerConfig = {
    databaseUrl: required('DATABASE_URL'),
    queueUrl: required('SQS_QUEUE_URL'),
    dlqUrl: required('SQS_DLQ_URL'),
    bucket: required('S3_QUARANTINE_BUCKET'),
    pollWaitSeconds: integer('WORKER_POLL_WAIT_SECONDS', 20, 1, 20),
    receiveMax: integer('WORKER_RECEIVE_MAX', 1, 1, 1),
    visibilityTimeoutSeconds: integer('WORKER_VISIBILITY_TIMEOUT_SECONDS', 120, 1, 43200),
    leaseMs: integer('WORKER_LEASE_MS', 120000, 1, 43200000),
    heartbeatMs: integer('WORKER_HEARTBEAT_MS', 30000, 1, 43200000),
    retryDelaySeconds: integer('WORKER_RETRY_DELAY_SECONDS', 1, 1, 300),
    retryDelayMaxSeconds: integer('WORKER_RETRY_DELAY_MAX_SECONDS', 300, 1, 300),
    awsRegion: env.AWS_DEFAULT_REGION?.trim() || 'us-east-1',
    ...(env.S3_ENDPOINT_URL?.trim() ? { s3EndpointUrl: env.S3_ENDPOINT_URL.trim() } : {}),
    ...(env.SQS_ENDPOINT_URL?.trim() ? { sqsEndpointUrl: env.SQS_ENDPOINT_URL.trim() } : {}),
  };
  if (config.heartbeatMs >= config.leaseMs || config.heartbeatMs >= config.visibilityTimeoutSeconds * 1000) {
    throw new Error('Worker heartbeat must be shorter than the lease and visibility timeout');
  }
  if (config.retryDelayMaxSeconds < config.retryDelaySeconds) {
    throw new Error('Worker retry delay maximum must be greater than or equal to the base delay');
  }
  return config;
}

export function retryDelaySeconds(attempt: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}
