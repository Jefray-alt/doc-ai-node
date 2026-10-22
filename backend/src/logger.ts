import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' ? {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  } : {}),
});

// SDK messages/stacks can contain credentials and signed URLs. Log only known
// error categories and numeric SDK diagnostics, never arbitrary error text.
export function errorDiagnostics(error: unknown) {
  const knownNames = new Set([
    'Error', 'TypeError', 'CredentialsProviderError', 'TokenProviderError',
    'TimeoutError', 'NetworkingError', 'AccessDenied', 'InvalidAccessKeyId',
    'SignatureDoesNotMatch', 'ServiceUnavailable', 'InternalError',
  ]);
  const name = error instanceof Error && knownNames.has(error.name)
    ? error.name : 'UnknownError';
  const metadata = typeof error === 'object' && error !== null && '$metadata' in error
    ? error.$metadata : undefined;
  const diagnostics: Record<string, string | number> = { name };

  if (typeof metadata === 'object' && metadata !== null) {
    for (const key of ['httpStatusCode', 'attempts', 'totalRetryDelay'] as const) {
      if (key in metadata) {
        const value = (metadata as Record<string, unknown>)[key];
        if (typeof value === 'number' && Number.isFinite(value)) diagnostics[key] = value;
      }
    }
  }

  return diagnostics;
}
