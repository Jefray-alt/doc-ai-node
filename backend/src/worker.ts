import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnvironment } from './environment.ts';
import { WorkerModule } from './worker.module.ts';

loadEnvironment();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks([], { useProcessExit: true });
}

void bootstrap();
