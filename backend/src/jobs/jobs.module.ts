import { Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository.ts';

@Module({ providers: [JobsRepository], exports: [JobsRepository] })
export class JobsModule {}
