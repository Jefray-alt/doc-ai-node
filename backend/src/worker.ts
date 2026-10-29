import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getScanWorkerConfig } from './scan-worker/scan-worker.config.js';
import { ScanWorkerModule } from './scan-worker/scan-worker.module.js';
import { ScanWorkerService } from './scan-worker/scan-worker.service.js';

const logger = new Logger('ScanWorkerBootstrap');

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

async function bootstrap(): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let worker: ScanWorkerService | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= worker?.stop();
  };

  try {
    getScanWorkerConfig();
    app = await NestFactory.createApplicationContext(ScanWorkerModule, { abortOnError: false });
    const activeWorker = app.get(ScanWorkerService);
    worker = activeWorker;
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    await activeWorker.run();
    await shutdownPromise;
  } catch (error) {
    logger.error(`Scan worker startup or runtime failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    if (app) {
      await app.close();
    }
  }
}

void bootstrap();
