import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(backend, 'dist/main.js');
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
});
