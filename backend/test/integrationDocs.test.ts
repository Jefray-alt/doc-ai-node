import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const motoGuide = await readFile(new URL('../../infra/moto/README.md', import.meta.url), 'utf8');
const frontendGuide = await readFile(new URL('../../frontend/README.md', import.meta.url), 'utf8');
const roadmap = await readFile(new URL('../../docs/roadmap.md', import.meta.url), 'utf8');

describe('staging upload integration documentation', () => {
  it('records reproducible browser-to-API-to-Moto behavior and evidence', () => {
    expect(motoGuide).toContain('## Browser-to-Moto upload integration');
    expect(motoGuide).toContain('if [ -e backend/.env ]');
    expect(motoGuide).toContain('Keeping existing backend/.env');
    expect(motoGuide).toContain('npm run dev');
    expect(motoGuide).toContain('CORS');
    expect(motoGuide).toMatch(/uploaded\s+bytes match/);
    expect(motoGuide).toContain('pdf-ready');
    expect(motoGuide).toContain('failure');
    expect(motoGuide).toContain('cancellation');
    expect(motoGuide).toContain('checksum');
    expect(motoGuide).toContain('signed URL');
    expect(frontendGuide).toContain('## Verified browser-to-Moto flow');
    expect(frontendGuide).toMatch(/uploaded\s+bytes match/);
  });

  it('keeps Feature 2 in progress and names deferred work', () => {
    expect(roadmap).toContain('Feature 2 remains in progress');
    expect(roadmap).toContain('validation');
    expect(roadmap).toContain('session attachment');
    expect(roadmap).toContain('cleanup');
    expect(roadmap).toContain('AWS permission and signature enforcement verification remains deferred');
  });
});
