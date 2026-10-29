import { fileURLToPath } from 'node:url';

export function loadBackendEnv(envFile = fileURLToPath(new URL('../.env', import.meta.url))) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}
