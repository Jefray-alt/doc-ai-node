export function loadEnvironment(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}
