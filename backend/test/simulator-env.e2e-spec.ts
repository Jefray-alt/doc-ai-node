import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local simulator environment loading', () => {
  it('uses Node env-file parsing and preserves shell values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-ai-env-test-'));
    const envFile = join(directory, 'backend.env');
    writeFileSync(envFile, [
      'T3_ENV_INLINE=value # trailing comment',
      'T3_ENV_QUOTED="quoted value" # trailing comment',
      'T3_ENV_FROM_SHELL=from-file',
    ].join('\n'));
    const moduleUrl = new URL('../scripts/backend-env.mjs', import.meta.url).href;
    const program = `import { loadBackendEnv } from ${JSON.stringify(moduleUrl)}; await loadBackendEnv(${JSON.stringify(envFile)}); console.log(JSON.stringify([process.env.T3_ENV_INLINE, process.env.T3_ENV_QUOTED, process.env.T3_ENV_FROM_SHELL]));`;

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
        encoding: 'utf8',
        env: { ...process.env, T3_ENV_FROM_SHELL: 'from-shell' },
      }).trim();
      expect(JSON.parse(output)).toEqual(['value', 'quoted value', 'from-shell']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
