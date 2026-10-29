import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(backend, 'dist/main.js');
const workerEntry = resolve(backend, 'dist/worker.js');
const children: ReturnType<typeof spawn>[] = [];
const fixtures: string[] = [];

function fixture(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'backend-startup-'));
  fixtures.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a port');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function expectHealth(port: number, options: { filePort?: number; shellPort?: number } = {}) {
  const cwd = fixture();
  if (options.filePort !== undefined) writeFileSync(resolve(cwd, '.env'), `PORT=${options.filePort}\n`);
  const env = { ...process.env };
  delete env.PORT;
  if (options.shellPort !== undefined) env.PORT = String(options.shellPort);

  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited (${child.exitCode}): ${output}`);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      continue;
    }
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(body).toEqual({ status: 'ok' });
    return;
  }
  throw new Error(`Backend did not answer on port ${port}: ${output}`);
}

async function expectWorkerStartsFromEnvFile(): Promise<void> {
  const cwd = fixture();
  writeFileSync(resolve(cwd, '.env'), [
    'SQS_QUEUE_URL=http://127.0.0.1:1/000000000000/worker-test',
    'S3_QUARANTINE_BUCKET=quarantine',
    'SQS_ENDPOINT_URL=http://127.0.0.1:1',
    'SCAN_WORKER_CONCURRENCY=2',
    'SCAN_WORKER_POLL_BACKOFF_MS=100',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_DEFAULT_REGION: 'us-east-1', SCAN_WORKER_CONCURRENCY: '3' };
  delete env.SQS_QUEUE_URL;
  delete env.S3_QUARANTINE_BUCKET;

  const child = spawn(process.execPath, [workerEntry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !output.includes('Scan worker started with concurrency 3')) {
    const exit = await Promise.race([
      exited,
      new Promise<undefined>((resolveDelay) => setTimeout(() => resolveDelay(undefined), 50)),
    ]);
    if (exit) throw new Error(`Worker exited before startup (${exit.code ?? exit.signal}): ${output}`);
  }
  expect(output).toContain('Scan worker started with concurrency 3');
  child.kill('SIGINT');
  const exit = await exited;
  expect(exit.code).toBe(0);
}

describe.sequential('compiled process startup', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: backend, stdio: 'inherit' });
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => new Promise<void>((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveClose();
      });
      child.kill('SIGTERM');
    })));
    for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('emits the production entry point without legacy or test artifacts', () => {
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(resolve(backend, 'dist/server.js'))).toBe(false);
    expect(existsSync(resolve(backend, 'dist/app.js'))).toBe(false);
    expect(existsSync(resolve(backend, 'dist/test'))).toBe(false);
    expect(existsSync(resolve(backend, 'dist/vitest.config.js'))).toBe(false);
  });

  it('starts without an env file and uses port 3000 by default', async () => {
    await expectHealth(3000);
  });

  it('uses PORT from the shell environment', async () => {
    const port = await availablePort();
    await expectHealth(port, { shellPort: port });
  });

  it('loads PORT from the working directory env file', async () => {
    const port = await availablePort();
    await expectHealth(port, { filePort: port });
  });

  it('gives the shell PORT precedence over the env file', async () => {
    const filePort = await availablePort();
    const shellPort = await availablePort();
    await expectHealth(shellPort, { filePort, shellPort });
  });

  it('loads the worker queue from .env and preserves shell setting precedence', async () => {
    await expectWorkerStartsFromEnvFile();
  });
});
