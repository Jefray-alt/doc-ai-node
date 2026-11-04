export interface S3StorageConfig {
  region: string;
  endpoint?: string;
  quarantineBucket: string;
  cleanBucket: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export function getS3StorageConfig(env: NodeJS.ProcessEnv = process.env): S3StorageConfig {
  const credentials = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      }
    : undefined;

  return {
    region: env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(env.S3_ENDPOINT_URL ? { endpoint: env.S3_ENDPOINT_URL } : {}),
    quarantineBucket: env.S3_QUARANTINE_BUCKET ?? 'doc-ai-local-quarantine',
    cleanBucket: env.S3_CLEAN_BUCKET ?? 'doc-ai-local-pdfs',
    ...(credentials ? { credentials } : {}),
  };
}
