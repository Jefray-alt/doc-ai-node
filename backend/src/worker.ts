import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnvironment } from './environment.js';
import { WorkerModule } from './worker.module.js';

loadEnvironment();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks([], { useProcessExit: true });
}

void bootstrap();
