import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';
import { WorkerService } from './worker/worker.service.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(), { logger: ['error', 'warn', 'log'] });
  const worker = app.get(WorkerService);
  const close = async (): Promise<void> => {
    await worker.stop();
    worker.closeClients();
    await app.close();
  };
  let closing: Promise<void> | undefined;
  const shutdown = (): void => {
    closing ??= close().catch((error: unknown) => {
      process.stderr.write(`worker shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  worker.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
